// 本地字幕插件 - 前端主逻辑（批量识别版）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 状态
    var allSequences = [];       // [{ name, sequenceID, end, active }]
    var currentClips = [];       // 当前查看序列的片段
    var subtitles = [];          // 当前查看序列的字幕
    var currentSeqId = null;     // 当前查看的序列 ID
    var batchResults = [];       // 批量结果 [{ seqId, name, status, count, subtitles }]
    var stopRequested = false;   // 停止标志
    var sepVocalsPath = null;    // 人声分离产物：人声
    var sepAccompPath = null;    // 人声分离产物：伴奏
    var sepBusy = false;         // 分离是否进行中

    // DOM 引用
    var el = {
        seqList: document.getElementById('seqList'),
        refreshSeq: document.getElementById('btnRefreshSeq'),
        toggleAll: document.getElementById('btnToggleAll'),
        selLang: document.getElementById('selLang'),
        selRange: document.getElementById('selRange'),
        selModel: document.getElementById('selModel'),
        chkGpu: document.getElementById('chkGpu'),
        batch: document.getElementById('btnBatch'),
        stop: document.getElementById('btnStop'),
        progressWrap: document.getElementById('progressWrap'),
        progressFill: document.getElementById('progressFill'),
        progressText: document.getElementById('progressText'),
        status: document.getElementById('status'),
        resultCard: document.getElementById('resultCard'),
        resultSummary: document.getElementById('resultSummary'),
        list: document.getElementById('subtitleList'),
        writeBack: document.getElementById('btnWriteBack'),
        exportSrt: document.getElementById('btnExportSrt'),
        btnSeparate: document.getElementById('btnSeparate'),
        btnImportVocals: document.getElementById('btnImportVocals'),
        btnImportAccomp: document.getElementById('btnImportAccomp'),
        sepProgressWrap: document.getElementById('sepProgressWrap'),
        sepProgressFill: document.getElementById('sepProgressFill'),
        sepProgressText: document.getElementById('sepProgressText'),
        sepStatus: document.getElementById('sepStatus')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    function setProgress(pct, text) {
        if (pct < 0) {
            el.progressFill.className = 'fill indet';
            el.progressText.textContent = text || '';
        } else {
            el.progressFill.className = 'fill';
            el.progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
            el.progressText.textContent = text || '';
        }
    }

    function setBusy(busy) {
        el.batch.disabled = busy;
        el.writeBack.disabled = busy;
        el.refreshSeq.disabled = busy;
        if (busy) {
            el.progressWrap.classList.add('show');
            el.stop.style.display = '';
        } else {
            el.progressWrap.classList.remove('show');
            el.stop.style.display = 'none';
        }
    }

    // ---------- 1. 序列列表 ----------
    function refreshSequences() {
        setStatus('读取序列列表...', '');
        csInterface.evalScript('wsGetAllSequencesStr()', function (result) {
            try {
                var data = JSON.parse(result);
                if (data.error) { setStatus(data.error, 'err'); return; }
                allSequences = data.sequences || [];
                renderSeqList();
                setStatus('共 ' + allSequences.length + ' 个序列，勾选要识别的（默认选中当前活动序列）', 'ok');
            } catch (e) {
                setStatus('解析失败: ' + e.toString() + ' | ' + result, 'err');
            }
        });
    }

    function renderSeqList() {
        el.seqList.innerHTML = '';
        if (allSequences.length === 0) {
            el.seqList.innerHTML = '<div class="hint" style="padding:6px 8px;">项目里没有序列</div>';
            return;
        }
        allSequences.forEach(function (s) {
            var div = document.createElement('div');
            div.className = 'seq-item';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!s.active;   // 默认勾选当前活动序列
            cb.dataset.id = s.sequenceID;
            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = s.name;
            var dur = document.createElement('span');
            dur.className = 'dur';
            dur.textContent = (s.end || 0).toFixed(1) + 's';
            div.appendChild(cb);
            div.appendChild(nm);
            if (s.active) {
                var badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = '当前';
                div.appendChild(badge);
            }
            div.appendChild(dur);
            el.seqList.appendChild(div);
        });
    }

    function getSelectedSeqIds() {
        var ids = [];
        var boxes = el.seqList.querySelectorAll('input[type=checkbox]');
        boxes.forEach(function (cb) { if (cb.checked) ids.push(cb.dataset.id); });
        return ids;
    }

    function toggleAll() {
        var boxes = el.seqList.querySelectorAll('input[type=checkbox]');
        var allChecked = true;
        boxes.forEach(function (cb) { if (!cb.checked) allChecked = false; });
        boxes.forEach(function (cb) { cb.checked = !allChecked; });
    }

    // ---------- 2. 混音参数 ----------
    function buildMixArgs(clips, outWav) {
        var inputs = [];
        var filters = [];
        clips.forEach(function (c, idx) {
            inputs.push('-ss', c.inPoint.toFixed(3));
            inputs.push('-t', c.duration.toFixed(3));
            inputs.push('-i', c.mediaPath);
            var ms = Math.round(c.seqStart * 1000);
            filters.push(
                '[' + idx + ':a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,' +
                'asetpts=PTS-STARTPTS,adelay=' + ms + '[a' + idx + ']'
            );
        });
        var amixInputs = clips.map(function (_, idx) { return '[a' + idx + ']'; }).join('');
        var amix = amixInputs + 'amix=inputs=' + clips.length + ':normalize=0:duration=longest[out]';
        var args = inputs.concat([
            '-filter_complex', filters.join(';') + ';' + amix,
            '-map', '[out]',
            '-ar', '16000', '-ac', '1',
            '-y', outWav
        ]);
        return args;
    }

    // ---------- 3. 批量识别 ----------
    function runBatch() {
        if (stopRequested) { stopRequested = false; return; }
        var ids = getSelectedSeqIds();
        if (ids.length === 0) { setStatus('请先勾选要识别的序列', 'err'); return; }

        var useGpu = el.chkGpu.checked;
        var modelName = el.selModel.value;
        var lang = el.selLang.value;
        var rangeMode = el.selRange.value;   // 'all' | 'inout' | 'selection'

        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        // GPU 自动检测：能加载 cuda 库就用 CUDA 版，否则降级纯 CPU 版
        var cudaWhisperPath = path.join(extRoot, 'bin', 'whisper', 'cuda', 'whisper-cli.exe');
        var cpuWhisperPath = path.join(extRoot, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe');
        var cudaOk = detectCudaAvailable(cudaWhisperPath);
        var whisperPath;
        if (cudaOk) {
            whisperPath = cudaWhisperPath;
            if (!useGpu) setStatus('GPU 已禁用，英文将用 CUDA 版跑 CPU 模式', '');
        } else {
            whisperPath = cpuWhisperPath;
            useGpu = false;  // 纯 CPU 版无 GPU 能力
            if (lang !== 'zh') setStatus('未检测到可用 CUDA 环境，英文已降级纯 CPU 模式', 'warn');
        }
        var modelPath = path.join(extRoot, 'models', modelName);
        var funasrCli = path.join(extRoot, 'py', 'funasr_cli.py');
        var funasrModelDir = path.join(extRoot, 'models', 'funasr');

        if (!fs.existsSync(ffmpegPath)) { setStatus('FFmpeg 缺失: ' + ffmpegPath, 'err'); return; }
        if (lang === 'zh') {
            if (!fs.existsSync(funasrCli)) { setStatus('FunASR 脚本缺失: ' + funasrCli, 'err'); return; }
            if (!fs.existsSync(funasrModelDir)) { setStatus('FunASR 模型缺失: ' + funasrModelDir, 'err'); return; }
        } else {
            if (!fs.existsSync(whisperPath)) { setStatus('Whisper 缺失: ' + whisperPath, 'err'); return; }
            if (!fs.existsSync(modelPath)) { setStatus('模型缺失: ' + modelPath, 'err'); return; }
        }

        stopRequested = false;
        batchResults = [];
        el.resultCard.style.display = 'none';
        setBusy(true);

        // 明确标识当前引擎，方便一眼判断走的是哪条路
        var engineName = (lang === 'zh') ? 'FunASR（中文·paraformer）' : 'whisper large-v3';
        setStatus('引擎：' + engineName + '，准备识别...', '');

        // 临时目录（英文路径，whisper 对中文路径会崩溃）
        var tmpDir = path.join(os.tmpdir(), 'ws_subtitle');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        // 先收集所有序列的片段信息
        var seqMetas = [];   // [{ seqId, seqName, clips }]
        var collected = 0;
        setStatus('正在读取 ' + ids.length + ' 个序列的片段信息...', '');
        setProgress(0, '读取序列片段 0/' + ids.length);

        function collectNext(idx) {
            if (stopRequested || idx >= ids.length) {
                if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                startTranscribing();
                return;
            }
            var seqId = ids[idx];
            var evalStr = (rangeMode === 'all')
                ? 'wsGetSequenceClipsStr("' + seqId + '")'
                : 'wsGetSequenceClipsRangeStr("' + seqId + '", "' + rangeMode + '")';
            csInterface.evalScript(evalStr, function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.error) {
                        seqMetas.push({ seqId: seqId, seqName: '序列 ' + seqId.slice(0, 8), clips: [], error: data.error });
                    } else {
                        seqMetas.push({ seqId: seqId, seqName: data.seqName, clips: data.clips || [] });
                    }
                } catch (e) {
                    seqMetas.push({ seqId: seqId, seqName: '序列 ' + seqId.slice(0, 8), clips: [], error: e.toString() });
                }
                collected++;
                setProgress(Math.round(collected / ids.length * 10), '读取序列片段 ' + collected + '/' + ids.length);
                collectNext(idx + 1);
            });
        }

        function startTranscribing() {
            var valid = seqMetas.filter(function (m) { return m.clips && m.clips.length > 0; });
            if (valid.length === 0) {
                setBusy(false);
                // 把每条序列的具体错误透出来，便于定位（不再笼统提示）
                var firstErr = null;
                seqMetas.forEach(function (m) { if (m.error && !firstErr) firstErr = m.error; });
                if (firstErr) {
                    setStatus('没有可识别内容：' + firstErr, 'err');
                } else {
                    setStatus('没有可识别的序列（可能都是空序列或无媒体）', 'err');
                }
                return;
            }
            var total = valid.length;
            setProgress(10, '准备识别 ' + total + ' 个序列');

            // 中文走 FunASR 批量模式：先全部混音，再一次性识别（模型只加载一次）
            if (lang === 'zh') {
                transcribeZhBatch(valid);
            } else {
                var done = 0;
                function transcribeNext(i) {
                    if (stopRequested || i >= total) {
                        if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); }
                        else { finishBatch(); }
                        return;
                    }
                    var meta = valid[i];
                    setStatus('识别中 [' + (i + 1) + '/' + total + '] ' + meta.seqName + '...', '');
                    transcribeOne(meta, function (result) {
                        batchResults.push(result);
                        done++;
                        var base = 10 + Math.round(done / total * 85);
                        setProgress(base, '已完成 ' + done + '/' + total + ' 个序列');
                        transcribeNext(i + 1);
                    });
                }
                transcribeNext(0);
            }
        }

        // 中文批量：先串行混音（快），再一次性 FunASR 识别（模型只加载一次，省 N-1 次 4.6 秒加载）
        function transcribeZhBatch(metas) {
            var total = metas.length;
            var mixTaskList = [];  // [{ meta, wavPath }]
            var mixErrors = [];    // [{ meta, error }]

            function mixNext(i) {
                if (stopRequested || i >= total) {
                    if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                    runZhRecognize();
                    return;
                }
                var meta = metas[i];
                var wavPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.wav');
                try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}
                setStatus('混音中 [' + (i + 1) + '/' + total + '] ' + meta.seqName + '...', '');
                setProgress(10 + Math.round(i / total * 30), '混音 ' + (i + 1) + '/' + total);
                var mixArgs = buildMixArgs(meta.clips, wavPath);
                child_process.execFile(ffmpegPath, mixArgs, {
                    timeout: 300000,
                    maxBuffer: 1024 * 1024 * 20
                }, function (err) {
                    if (err || !fs.existsSync(wavPath)) {
                        mixErrors.push({ meta: meta, error: '混音失败: ' + (err ? err.message : '未生成 wav') });
                    } else {
                        mixTaskList.push({ meta: meta, wavPath: wavPath });
                    }
                    mixNext(i + 1);
                });
            }

            function runZhRecognize() {
                if (mixTaskList.length === 0) {
                    // 全部混音失败
                    mixErrors.forEach(function (e) {
                        batchResults.push({ seqId: e.meta.seqId, name: e.meta.seqName, status: 'err', error: e.error });
                    });
                    finishBatch();
                    return;
                }

                var pythonExe = detectPython();
                if (!pythonExe) {
                    setBusy(false);
                    setStatus('未找到 Python 环境（需安装 Python 3.9+ 并 pip install funasr）', 'err');
                    return;
                }

                var listJsonPath = path.join(tmpDir, 'funasr_list.json');
                var outJsonPath = path.join(tmpDir, 'funasr_out.json');
                var tasks = mixTaskList.map(function (t) {
                    return { id: t.meta.seqId, wav: t.wavPath };
                });
                fs.writeFileSync(listJsonPath, JSON.stringify(tasks), 'utf8');

                setStatus('FunASR 识别中（模型加载约 4.6 秒，之后很快）...', '');
                setProgress(40, 'FunASR 识别 0/' + mixTaskList.length);

                var proc = child_process.execFile(pythonExe, [funasrCli, '--multi', listJsonPath, outJsonPath], {
                    timeout: 1800000,
                    maxBuffer: 1024 * 1024 * 50
                }, function (error, stdout, stderr) {
                    if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                    if (error) {
                        var detail = (stderr || stdout || '').substring(0, 800);
                        setBusy(false);
                        setStatus('FunASR 识别失败: ' + error.message + ' ' + detail, 'err');
                        return;
                    }
                    if (!fs.existsSync(outJsonPath)) {
                        setBusy(false);
                        setStatus('FunASR 未生成结果', 'err');
                        return;
                    }
                    var resultMap;
                    try {
                        resultMap = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
                    } catch (e) {
                        setBusy(false);
                        setStatus('FunASR 结果解析失败: ' + e.toString(), 'err');
                        return;
                    }
                    // 组装 batchResults
                    mixTaskList.forEach(function (t) {
                        var subs = resultMap[t.meta.seqId] || [];
                        if (subs.length === 0) {
                            batchResults.push({ seqId: t.meta.seqId, name: t.meta.seqName, status: 'err', error: 'FunASR 未识别到内容' });
                        } else {
                            batchResults.push({ seqId: t.meta.seqId, name: t.meta.seqName, status: 'ok', count: subs.length, subtitles: subs });
                        }
                    });
                    mixErrors.forEach(function (e) {
                        batchResults.push({ seqId: e.meta.seqId, name: e.meta.seqName, status: 'err', error: e.error });
                    });
                    finishBatch();
                });

                // 读取 stderr 里的 PROGRESS 行，更新进度条
                proc.stderr.on('data', function (chunk) {
                    var s = chunk.toString();
                    var m = s.match(/PROGRESS\s+(\d+)\/(\d+)/);
                    if (m) {
                        var cur = parseInt(m[1], 10);
                        var tot = parseInt(m[2], 10);
                        setProgress(40 + Math.round(cur / tot * 55), 'FunASR 识别 ' + cur + '/' + tot);
                    }
                });
            }

            mixNext(0);
        }

        // 单序列（英文/whisper 用）：混音 → whisper → 解析
        function transcribeOne(meta, cb) {
            var wavPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.wav');
            var srtPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.srt');
            try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}
            try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); } catch (e) {}

            var mixArgs = buildMixArgs(meta.clips, wavPath);
            child_process.execFile(ffmpegPath, mixArgs, {
                timeout: 300000,
                maxBuffer: 1024 * 1024 * 20
            }, function (err) {
                if (err) {
                    cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '混音失败: ' + err.message });
                    return;
                }
                if (!fs.existsSync(wavPath)) {
                    cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '混音未生成 wav' });
                    return;
                }
                runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb);
            });
        }

        collectNext(0);
    }

    // 跑 whisper（带进度回调 + GPU 开关 + 停止）
    function runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb) {
        var args = [
            '-m', modelPath,
            '-l', lang,
            '-t', '4',
            '-osrt',
            '-of', path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8)),
            '-pp',
            '-nf',              // 禁用 temperature fallback：堵住"听不懂就硬编"的幻觉源头（保留）
            '-sns',             // 抑制非语音 token，减少"(音乐)"这类杂音（保留）
            wavPath
        ];
        if (!useGpu) args.push('-ng');

        var proc = child_process.execFile(whisperPath, args, {
            cwd: path.dirname(whisperPath),
            timeout: 1800000,
            maxBuffer: 1024 * 1024 * 50
        }, function (error, stdout, stderr) {
            if (stopRequested) { cb({ seqId: meta.seqId, name: meta.seqName, status: 'stopped' }); return; }
            if (error) {
                var detail = (stderr || stdout || '').substring(0, 500);
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '识别失败: ' + error.message + ' ' + detail });
                return;
            }
            var srtContent = '';
            try { srtContent = fs.readFileSync(srtPath, 'utf8'); } catch (e) {
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '未生成 srt' });
                return;
            }
            var subs = parseSRT(srtContent);
            cb({ seqId: meta.seqId, name: meta.seqName, status: 'ok', count: subs.length, subtitles: subs });
        });

        // 解析 whisper 进度（progress = XX%）
        proc.stderr.on('data', function (chunk) {
            var s = chunk.toString();
            var m = s.match(/progress\s*=\s*(\d+)%/);
            if (m) {
                var p = parseInt(m[1], 10);
                setStatus('识别中 [' + meta.name + '] ' + p + '%...', '');
            }
        });
    }

    // 检测 CUDA 版 whisper 是否可用：关键 DLL 存在 + 能成功执行 --help（验证驱动兼容）
    function detectCudaAvailable(cudaWhisperPath) {
        try {
            var cudaDir = path.dirname(cudaWhisperPath);
            // 关键 CUDA 依赖 DLL 必须都在
            var requiredDlls = [
                'cublas64_12.dll', 'cublasLt64_12.dll', 'ggml-cuda.dll', 'whisper.dll'
            ];
            for (var i = 0; i < requiredDlls.length; i++) {
                if (!fs.existsSync(path.join(cudaDir, requiredDlls[i]))) {
                    return false;
                }
            }
            // 实跑 --help 验证：若驱动不兼容，cublas 加载失败会退出码非 0 或报错
            var r = child_process.spawnSync(cudaWhisperPath, ['--help'], {
                cwd: cudaDir,
                encoding: 'utf8',
                timeout: 15000
            });
            if (r.error) return false;
            var out = (r.stdout || '') + (r.stderr || '');
            // 可靠信号：能打印出 "found N CUDA devices" 说明 cublas/驱动加载成功；
            // usage 文本作为弱兜底（可执行文件本身能跑）
            if (/found\s+\d+\s+CUDA\s+devices/i.test(out)) return true;
            if (/usage/i.test(out) && /--model/i.test(out)) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    // 探测 Python 可执行文件：优先便携版（runtime/python.exe，随插件携带），系统 Python 兑底
    function detectPython() {
        var candidates = [
            path.join(extRoot, 'runtime', 'python.exe'),          // 便携 Python（分发版自带）
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
            'python',
            'py'
        ];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c === 'python' || c === 'py') {
                // 用 where 探测，避免 spawn 到 WindowsApps 的假 python
                try {
                    var r = child_process.spawnSync('where', [c], { encoding: 'utf8' });
                    if (r.status === 0 && r.stdout) {
                        var lines = r.stdout.split(/\r?\n/).filter(function (l) { return l.trim(); });
                        for (var j = 0; j < lines.length; j++) {
                            var p = lines[j].trim();
                            // 排除 WindowsApps 商店占位符
                            if (p.indexOf('WindowsApps') < 0) return p;
                        }
                    }
                } catch (e) {}
            } else if (fs.existsSync(c)) {
                return c;
            }
        }
        return null;
    }

    function finishBatch() {
        setBusy(false);
        setProgress(100, '完成');
        var okCount = batchResults.filter(function (r) { return r.status === 'ok'; }).length;
        setStatus('批量完成：成功 ' + okCount + '/' + batchResults.length + ' 个序列', 'ok');
        renderBatchResults();
        el.resultCard.style.display = 'block';
    }

    // ---------- 4. 结果展示 ----------
    function renderBatchResults() {
        el.resultSummary.innerHTML = '';
        batchResults.forEach(function (r, i) {
            var div = document.createElement('div');
            div.className = 'result-item';
            div.dataset.index = i;
            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = r.name;
            var tag = document.createElement('span');
            if (r.status === 'ok') {
                tag.className = 'ok-tag';
                tag.textContent = '✓ ' + r.count + ' 条';
            } else if (r.status === 'err') {
                tag.className = 'err-tag';
                tag.textContent = '✗ 失败';
                div.title = r.error;
            } else {
                tag.className = 'err-tag';
                tag.textContent = '已停止';
            }
            div.appendChild(nm);
            div.appendChild(tag);
            div.onclick = function () { selectResult(i); };
            el.resultSummary.appendChild(div);
        });
        // 默认选中第一个成功的
        var firstOk = batchResults.findIndex(function (r) { return r.status === 'ok'; });
        if (firstOk >= 0) selectResult(firstOk);
    }

    function selectResult(i) {
        var r = batchResults[i];
        if (!r || r.status !== 'ok') return;
        currentSeqId = r.seqId;
        subtitles = r.subtitles || [];
        // 高亮
        var items = el.resultSummary.querySelectorAll('.result-item');
        items.forEach(function (it, idx) { it.classList.toggle('sel', idx === i); });
        renderList();
        setStatus('当前查看：' + r.name + '（' + subtitles.length + ' 条）', 'ok');
    }

    // ---------- SRT 解析（秒）----------
    function parseSRT(content) {
        var subs = [];
        var lines = content.replace(/\r\n/g, '\n').split('\n');
        var i = 0;
        while (i < lines.length) {
            while (i < lines.length && lines[i].trim() === '') i++;
            if (i >= lines.length) break;
            if (/^\d+$/.test(lines[i].trim())) i++;
            if (i >= lines.length) break;
            var timeMatch = lines[i].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
            if (!timeMatch) { i++; continue; }
            var start = parseTime(timeMatch[1]);
            var end = parseTime(timeMatch[2]);
            i++;
            var text = [];
            while (i < lines.length && lines[i].trim() !== '') {
                text.push(lines[i].trim());
                i++;
            }
            subs.push({ start: start, end: end, text: text.join('\n') });
        }
        return subs;
    }

    function parseTime(t) {
        var m = t.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        var h = parseInt(m[1]), mi = parseInt(m[2]), s = parseInt(m[3]), ms = parseInt(m[4]);
        return h * 3600 + mi * 60 + s + ms / 1000;
    }

    function formatTime(sec) {
        var ms = Math.round(sec * 1000);
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        var s = Math.floor((ms % 60000) / 1000);
        var millis = ms % 1000;
        function pad(n, w) { n = '' + n; while (n.length < w) n = '0' + n; return n; }
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(millis, 3);
    }

    function toSRT(subs) {
        var out = '';
        subs.forEach(function (s, i) {
            out += (i + 1) + '\n';
            out += formatTime(s.start) + ' --> ' + formatTime(s.end) + '\n';
            out += s.text + '\n\n';
        });
        return out;
    }

    // ---------- 渲染字幕列表 ----------
    function renderList() {
        el.list.innerHTML = '';
        subtitles.forEach(function (s, i) {
            var div = document.createElement('div');
            div.className = 'subtitle-item';
            div.dataset.index = i;
            div.innerHTML =
                '<span class="t">' + formatTime(s.start) + ' → ' + formatTime(s.end) + '</span>' +
                '<span class="x">' + escapeHtml(s.text) + '</span>';
            div.onclick = function () { editSubtitle(i, div); };
            el.list.appendChild(div);
        });
    }

    function editSubtitle(i, div) {
        div.classList.add('editing');
        var s = subtitles[i];
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'edit-input';
        input.style.cssText = 'background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;width:100%;';
        input.value = s.text;
        div.appendChild(input);
        input.focus();
        input.select();
        var done = function () {
            s.text = input.value;
            renderList();
        };
        input.onblur = done;
        input.onkeydown = function (e) {
            if (e.key === 'Enter') { input.blur(); }
        };
    }

    // ---------- 回写字幕轨 ----------
    function writeBack() {
        if (!currentSeqId) { setStatus('请先在结果区选择一个序列', 'err'); return; }
        if (subtitles.length === 0) { setStatus('当前序列没有字幕可回写', 'err'); return; }

        var srtContent = toSRT(subtitles);
        // 带上序列名，host 侧用它给 srt 文件命名
        var seqName = '';
        var hit = batchResults.filter(function (r) { return r.seqId === currentSeqId; });
        if (hit.length > 0) seqName = hit[0].name || '';

        var payloadJson = JSON.stringify({ srt: srtContent, seqName: seqName });
        var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsWriteBackStr("' + currentSeqId + '")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已回写字幕轨（' + (data.fileName || '') + '）', 'ok');
                    } else {
                        setStatus(data.error || '回写失败', 'err');
                    }
                } catch (e) {
                    setStatus('回写解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 导出 SRT ----------
    function exportSrt() {
        if (!currentSeqId) { setStatus('请先在结果区选择一个序列', 'err'); return; }
        if (subtitles.length === 0) { setStatus('当前序列没有字幕可导出', 'err'); return; }
        var content = toSRT(subtitles);
        cep.fs.showSaveDialog('导出字幕', '', ['.srt'], function (path) {
            if (path) {
                fs.writeFileSync(path, content, 'utf8');
                setStatus('已导出: ' + path, 'ok');
            }
        });
    }

    // ---------- 人声分离（Spleeter 2-stem，本地引擎）----------
    // 关键：sherpa-onnx-offline-source-separation 是纯 C++ 程序，
    // 和 whisper 一样处理不了中文路径（内部 ANSI 代码页），
    // 所以引擎 + 模型 + 输入输出 wav 全部放到英文目录。
    function getSepDir() {
        return path.join(os.homedir(), 'whisper_subtitle_sep');
    }

    function ensureSepAssets(cb) {
        var sepDir = getSepDir();
        var needed = [
            { src: path.join(extRoot, 'bin', 'sherpa', 'sherpa-onnx-offline-source-separation.exe'), dst: path.join(sepDir, 'sherpa-onnx-offline-source-separation.exe') },
            { src: path.join(extRoot, 'bin', 'sherpa', 'onnxruntime.dll'), dst: path.join(sepDir, 'onnxruntime.dll') },
            { src: path.join(extRoot, 'bin', 'sherpa', 'onnxruntime_providers_shared.dll'), dst: path.join(sepDir, 'onnxruntime_providers_shared.dll') },
            { src: path.join(extRoot, 'models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'vocals.fp16.onnx'), dst: path.join(sepDir, 'vocals.fp16.onnx') },
            { src: path.join(extRoot, 'models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'accompaniment.fp16.onnx'), dst: path.join(sepDir, 'accompaniment.fp16.onnx') }
        ];
        try {
            if (!fs.existsSync(sepDir)) fs.mkdirSync(sepDir, { recursive: true });
        } catch (e) { return cb('无法创建分离工作目录: ' + e.toString()); }
        var missing = [];
        for (var i = 0; i < needed.length; i++) {
            if (!fs.existsSync(needed[i].src)) {
                missing.push(needed[i].src);
                continue;
            }
            if (!fs.existsSync(needed[i].dst)) {
                try { fs.copyFileSync(needed[i].src, needed[i].dst); } catch (e) {
                    return cb('复制分离组件失败: ' + e.toString());
                }
            }
        }
        if (missing.length > 0) {
            return cb('人声分离组件缺失: ' + missing.join(', '));
        }
        cb(null, sepDir);
    }

    function separateVocals() {
        if (sepBusy) { setSepStatus('分离进行中...', 'warn'); return; }

        // 找到当前活动序列
        var active = null;
        allSequences.forEach(function (s) { if (s.active) active = s; });
        if (!active) { setSepStatus('请先刷新序列列表，确认当前活动序列', 'err'); return; }

        setSepBusy(true);
        setSepStatus('正在读取选中的片段...', '');
        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        if (!fs.existsSync(ffmpegPath)) { setSepBusy(false); setSepStatus('FFmpeg 缺失', 'err'); return; }

        csInterface.evalScript('wsGetSequenceClipsRangeStr("' + active.sequenceID + '", "selection")', function (result) {
            var data;
            try { data = JSON.parse(result); } catch (e) {
                setSepBusy(false); setSepStatus('解析失败: ' + result, 'err'); return;
            }
            if (data.error || !data.clips || data.clips.length === 0) {
                setSepBusy(false);
                setSepStatus(data.error || '没有选中的片段', 'err');
                return;
            }
            // 取选中的第一个（人声分离通常针对单个素材）
            var clip = data.clips[0];
            if (!clip.mediaPath) { setSepBusy(false); setSepStatus('选中的片段没有媒体路径', 'err'); return; }

            ensureSepAssets(function (err, sepDir) {
                if (err) { setSepBusy(false); setSepStatus(err, 'err'); return; }

                var inputWav = path.join(sepDir, 'input.wav');
                var vocalsWav = path.join(sepDir, 'vocals.wav');
                var accompWav = path.join(sepDir, 'accomp.wav');
                try {
                    if (fs.existsSync(inputWav)) fs.unlinkSync(inputWav);
                    if (fs.existsSync(vocalsWav)) fs.unlinkSync(vocalsWav);
                    if (fs.existsSync(accompWav)) fs.unlinkSync(accompWav);
                } catch (e) {}

                // 输出文件用纯 ASCII 时间戳命名（sherpa 引擎处理不了中文文件名），
                // 后缀 _voice / _music 便于导入后区分人声/伴奏
                var ts = Date.now();
                var outVocals = path.join(sepDir, 'voice_' + ts + '.wav');
                var outAccomp = path.join(sepDir, 'music_' + ts + '.wav');

                // 1. ffmpeg 从素材源切出选中块音频（对齐素材内 in~out）
                var mixArgs = [
                    '-ss', clip.inPoint.toFixed(3),
                    '-t', (clip.outPoint - clip.inPoint).toFixed(3),
                    '-i', clip.mediaPath,
                    '-ac', '2', '-ar', '48000',
                    '-y', inputWav
                ];
                setSepStatus('正在提取选中片段音频...', '');
                child_process.execFile(ffmpegPath, mixArgs, { timeout: 300000, maxBuffer: 1024 * 1024 * 20 }, function (err) {
                    if (err || !fs.existsSync(inputWav)) {
                        setSepBusy(false);
                        setSepStatus('提取音频失败: ' + (err ? err.message : '未生成 wav'), 'err');
                        return;
                    }

                    // 2. 跑 sherpa 分离引擎（英文路径）
                    var exe = path.join(sepDir, 'sherpa-onnx-offline-source-separation.exe');
                    var sepArgs = [
                        '--spleeter-vocals=' + path.join(sepDir, 'vocals.fp16.onnx'),
                        '--spleeter-accompaniment=' + path.join(sepDir, 'accompaniment.fp16.onnx'),
                        '--num-threads=4',
                        '--input-wav=' + inputWav,
                        '--output-vocals-wav=' + outVocals,
                        '--output-accompaniment-wav=' + outAccomp
                    ];
                    setSepStatus('Spleeter 分离中（本地 CPU，很快）...', '');
                    child_process.execFile(exe, sepArgs, { cwd: sepDir, timeout: 1800000, maxBuffer: 1024 * 1024 * 50 }, function (err2) {
                        if (err2 || !fs.existsSync(outVocals)) {
                            setSepBusy(false);
                            setSepStatus('分离失败: ' + (err2 ? err2.message : '未生成人声文件'), 'err');
                            return;
                        }
                        sepVocalsPath = outVocals;
                        sepAccompPath = fs.existsSync(outAccomp) ? outAccomp : null;
                        el.btnImportVocals.disabled = false;
                        if (sepAccompPath) el.btnImportAccomp.disabled = false;
                        setSepBusy(false);
                        setSepStatus('分离完成：可分别导入人声 / 伴奏到「人声分离」素材箱', 'ok');
                    });
                });
            });
        });
    }

    function importVocals() {
        importToBin([sepVocalsPath], '人声');
    }

    function importAccomp() {
        importToBin([sepAccompPath], '伴奏');
    }

    // 通用导入：把文件列表放进「人声分离」素材箱，kind 用于提示文案
    function importToBin(files, kind) {
        var validFiles = files.filter(function (f) { return f && fs.existsSync(f); });
        if (validFiles.length === 0) { setSepStatus('请先分离出' + kind, 'err'); return; }
        setSepStatus('正在导入' + kind + '到素材箱...', '');
        var payloadJson = JSON.stringify(validFiles);
        var setScript = 'wsImportToBinPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsImportToBinStr("人声分离")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setSepStatus('已导入' + kind + '到「人声分离」素材箱：' + data.imported.join('、'), 'ok');
                    } else {
                        setSepStatus(data.error || '导入失败', 'err');
                    }
                } catch (e) {
                    setSepStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    function setSepStatus(msg, type) {
        el.sepStatus.textContent = msg || '';
        el.sepStatus.className = type || '';
    }

    function setSepBusy(busy) {
        sepBusy = busy;
        el.btnSeparate.disabled = busy;
        el.btnImportVocals.disabled = busy || !sepVocalsPath;
        el.btnImportAccomp.disabled = busy || !sepAccompPath;
        if (busy) {
            el.sepProgressWrap.classList.add('show');
            el.sepProgressFill.className = 'fill indet';
            el.sepProgressText.textContent = '人声分离进行中...';
        } else {
            el.sepProgressWrap.classList.remove('show');
        }
    }

    // ---------- 工具 ----------
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 事件绑定 ----------
    el.refreshSeq.addEventListener('click', refreshSequences);
    el.toggleAll.addEventListener('click', toggleAll);
    el.batch.addEventListener('click', runBatch);
    el.writeBack.addEventListener('click', writeBack);
    el.exportSrt.addEventListener('click', exportSrt);
    el.stop.addEventListener('click', function () {
        stopRequested = true;
        setStatus('正在停止...', 'warn');
    });

    el.btnSeparate.addEventListener('click', separateVocals);
    el.btnImportVocals.addEventListener('click', importVocals);
    el.btnImportAccomp.addEventListener('click', importAccomp);

    // 语言切换时联动模型框：中文→FunASR（固定，置灰）；英文/其他→whisper large-v3
    function syncModelByLang() {
        var lang = el.selLang.value;
        if (lang === 'zh') {
            el.selModel.value = 'funasr-zh';
            el.selModel.disabled = true;
        } else {
            el.selModel.value = 'ggml-large-v3-q5_0.bin';
            el.selModel.disabled = false;
        }
    }
    el.selLang.addEventListener('change', syncModelByLang);
    syncModelByLang();

    // 初始化
    setStatus('就绪。点「刷新序列列表」加载序列，勾选后批量识别', '');
    // 自动刷新一次
    refreshSequences();
})();
