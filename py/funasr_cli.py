# -*- coding: utf-8 -*-
"""
FunASR 中文识别 CLI（本地字幕插件专用）
用法: python funasr_cli.py <input.wav> <output.json>

- 加载 Alibaba FunASR 完整链路：paraformer(ASR) + fsmn-vad(端点) + ct-punc(标点)
- 输出 JSON 数组: [{start, end, text}]，start/end 为秒（绝对时间戳）
- 标点切句：句末标点(。！？；)与逗号(，、)都切，字幕文本不带标点
"""
import os
import sys
import json
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.abspath(os.path.join(HERE, '..', 'models', 'funasr'))
os.environ.setdefault('MODELSCOPE_CACHE', CACHE)

from funasr import AutoModel

MODEL_ASR = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
MODEL_VAD = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
MODEL_PUNC = "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"

# 断句标点：句末标点 + 逗号顿号（中英文都覆盖）
BREAK_PUNCT = set('。！？；，、.!?;,')


def is_punct(c):
    """判断是否为标点或空白。用 Unicode 类别判断，覆盖全部中英文标点（含全角引号“”等）。"""
    if c.isspace():
        return True
    return unicodedata.category(c).startswith('P')


_model = None


def get_model():
    global _model
    if _model is None:
        _model = AutoModel(
            model=MODEL_ASR,
            vad_model=MODEL_VAD,
            punc_model=MODEL_PUNC,
            disable_update=True,
        )
    return _model


def cut_sentences(text, ts):
    """按标点切句。ts 为逐字符 [[start_ms, end_ms], ...] 绝对时间戳（标点不占槽位）。

    用贪心对齐：遍历 text，每个非标点字符消费一个 ts 槽位。即使字符数与 ts 数量
    不完全一致也不会崩，更不会退回整段一条。
    """
    subs = []
    buf = ''
    buf_start_ts = None   # 本句首字符对应的 ts 下标
    ts_idx = 0            # 已消费的非标点字符数 = 下一个非标点字符对应的 ts 下标

    def flush(ts_end_exclusive):
        nonlocal buf, buf_start_ts
        txt = buf.strip()
        if not txt or not ts:
            buf = ''
            buf_start_ts = None
            return
        s_idx = buf_start_ts if buf_start_ts is not None else 0
        e_idx = ts_end_exclusive if ts_end_exclusive > s_idx else s_idx + 1
        # 越界保护
        if s_idx < 0:
            s_idx = 0
        if s_idx >= len(ts):
            s_idx = len(ts) - 1
        if e_idx > len(ts):
            e_idx = len(ts)
        if e_idx <= s_idx:
            e_idx = s_idx + 1
        if e_idx > len(ts):
            e_idx = len(ts)
        start = ts[s_idx][0] / 1000.0
        end = ts[e_idx - 1][1] / 1000.0
        subs.append({'start': round(start, 3), 'end': round(end, 3), 'text': txt})
        buf = ''
        buf_start_ts = None

    for c in text:
        if is_punct(c):
            if c in BREAK_PUNCT:
                flush(ts_idx)
            # 非断句标点（冒号、引号、括号等）：跳过，不占时间戳槽位
        else:
            if buf_start_ts is None:
                buf_start_ts = ts_idx
            buf += c
            ts_idx += 1

    flush(ts_idx)
    return subs


def recognize_one(model, wav):
    """识别单个 wav，返回字幕列表"""
    res = model.generate(input=wav, batch_size_s=300)
    subs = []
    for d in res:
        text = d.get('text', '') or ''
        ts = d.get('timestamp', []) or []
        if text and ts:
            subs.extend(cut_sentences(text, ts))
    return subs


def main():
    # 多文件模式：python funasr_cli.py --multi <list.json> <out.json>
    # list.json = [{"id": "...", "wav": "path"}, ...]
    # out.json  = {"id": [{start,end,text}, ...], ...}
    if '--multi' in sys.argv:
        try:
            mi = sys.argv.index('--multi')
            list_path = sys.argv[mi + 1]
            out_path = sys.argv[mi + 2]
        except (ValueError, IndexError):
            print(json.dumps({'error': 'usage: --multi <list.json> <out.json>'}, ensure_ascii=False))
            return 1

        with open(list_path, 'r', encoding='utf-8-sig') as f:
            tasks = json.load(f)

        model = get_model()  # 模型只加载一次
        result = {}
        n = len(tasks)
        for i, t in enumerate(tasks):
            # 进度打到 stderr，供 Node 实时读取
            print('PROGRESS %d/%d' % (i + 1, n), file=sys.stderr, flush=True)
            wid = t.get('id', str(i))
            wav = t.get('wav', '')
            if not wav or not os.path.exists(wav):
                result[wid] = []
                continue
            result[wid] = recognize_one(model, wav)

        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        return 0

    # 单文件模式（向后兼容）：python funasr_cli.py <input.wav> <output.json>
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'usage: funasr_cli.py <input.wav> <output.json>'}, ensure_ascii=False))
        return 1

    wav = sys.argv[1]
    out = sys.argv[2]

    if not os.path.exists(wav):
        print(json.dumps({'error': 'wav not found: ' + wav}, ensure_ascii=False))
        return 1

    model = get_model()
    subs = recognize_one(model, wav)

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(subs, f, ensure_ascii=False)

    # 诊断：切句异常少时告警到 stderr，方便排查
    if len(subs) <= 1:
        print('WARN: 切句异常，仅 %d 条' % len(subs), file=sys.stderr)

    return 0


if __name__ == '__main__':
    sys.exit(main())
