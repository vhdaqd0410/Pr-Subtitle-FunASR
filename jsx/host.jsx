// 本地字幕插件 - ExtendScript 宿主脚本
// 负责：读取序列信息、导入 srt、回写字幕轨

// ---------- 序列定位 ----------
function wsFindSequence(seqId) {
    try {
        if (!seqId) return app.project.activeSequence;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (s.sequenceID === seqId) return s;
        }
        return null;
    } catch (e) { return null; }
}

// ---------- 获取项目所有序列 ----------
function wsGetAllSequences() {
    try {
        var arr = [];
        var num = app.project.sequences.numSequences;
        var activeId = '';
        try { if (app.project.activeSequence) activeId = app.project.activeSequence.sequenceID; } catch (e) {}
        for (var i = 0; i < num; i++) {
            var s = app.project.sequences[i];
            arr.push({
                name: s.name,
                sequenceID: s.sequenceID,
                end: s.end.seconds,
                active: s.sequenceID === activeId
            });
        }
        return JSON.stringify({ sequences: arr });
    } catch (e) {
        return JSON.stringify({ error: '读取序列列表失败: ' + e.toString() });
    }
}

// ---------- 读取某个序列的音频片段信息 ----------
function wsGetSequenceClips(seqId) {
    try {
        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var clips = [];
        var i, j;
        var audioClips = [];
        var videoClips = [];

        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            var atr = seq.audioTracks[i];
            for (j = 0; j < atr.clips.numItems; j++) {
                var aclip = atr.clips[j];
                var aMediaPath = getClipMediaPath(aclip);
                if (aMediaPath) {
                    audioClips.push({
                        mediaPath: aMediaPath,
                        seqStart: aclip.start.seconds,
                        inPoint: aclip.inPoint.seconds,
                        outPoint: aclip.outPoint.seconds,
                        duration: aclip.outPoint.seconds - aclip.inPoint.seconds,
                        trackType: 'audio',
                        clipName: aclip.name
                    });
                }
            }
        }

        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            var vtr = seq.videoTracks[i];
            for (j = 0; j < vtr.clips.numItems; j++) {
                var vclip = vtr.clips[j];
                var vMediaPath = getClipMediaPath(vclip);
                if (vMediaPath) {
                    videoClips.push({
                        mediaPath: vMediaPath,
                        seqStart: vclip.start.seconds,
                        inPoint: vclip.inPoint.seconds,
                        outPoint: vclip.outPoint.seconds,
                        duration: vclip.outPoint.seconds - vclip.inPoint.seconds,
                        trackType: 'video',
                        clipName: vclip.name
                    });
                }
            }
        }

        if (audioClips.length > 0) clips = audioClips;
        else clips = videoClips;

        if (clips.length === 0) return JSON.stringify({ error: '序列里没有可识别的音视频片段' });

        return JSON.stringify({
            clips: clips,
            seqName: seq.name,
            seqEnd: seq.end.seconds,
            sourceTrack: audioClips.length > 0 ? 'audio' : 'video'
        });
    } catch (e) {
        return JSON.stringify({ error: '读取序列失败: ' + e.toString() });
    }
}

// 获取 clip 的媒体路径，拿不到返回空
function getClipMediaPath(clip) {
    try {
        var pi = clip.projectItem;
        if (pi) {
            if (pi.getMediaPath) return pi.getMediaPath();
            if (pi.mediaItem && pi.mediaItem.file) return pi.mediaItem.file.fsName;
        }
    } catch (e) {}
    return '';
}

// ---------- 回写字幕轨 ----------
// 关键：importFiles 返回的是 Boolean（成功与否），不是 ProjectItem 数组！
// 必须用 findItemsMatchingMediaPath 按文件路径找回刚导入的 ProjectItem，
// 否则 createCaptionTrack 收到布尔值会报 "illegal parameter type"。
function wsWriteBack(seqId) {
    try {
        var payload = wsWriteBackPayload;
        if (!payload) return JSON.stringify({ error: '无回写数据' });

        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var srtContent = payload.srt;
        var seqName = payload.seqName || seq.name || 'subtitle';

        // 1. 写 srt 到临时文件，文件名用「序列名 + 时间戳」，导入后一眼能认出是哪个序列的
        // 用 split/join 逐个替换非法字符，避免正则字面量在 ExtendScript(ES3) 里解析失败
        var safeName = seqName;
        var illegalChars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        for (var ci = 0; ci < illegalChars.length; ci++) {
            var ch = illegalChars[ci];
            while (safeName.indexOf(ch) >= 0) {
                safeName = safeName.split(ch).join('_');
            }
        }
        var ts = new Date();
        function pad2(n) { n = '' + n; return n.length < 2 ? '0' + n : n; }
        var stamp = ts.getFullYear() + pad2(ts.getMonth() + 1) + pad2(ts.getDate()) + '_' + pad2(ts.getHours()) + pad2(ts.getMinutes()) + pad2(ts.getSeconds());
        var fileName = safeName + '_' + stamp + '.srt';
        var tmpFile = new File(Folder.temp.fsName + '/' + fileName);
        tmpFile.encoding = 'UTF-8';
        tmpFile.open('w');
        tmpFile.write(srtContent);
        tmpFile.close();

        // 2. 导入到项目（返回 boolean）
        var ok = app.project.importFiles([tmpFile.fsName], true, app.project.rootItem, false);
        if (!ok) {
            return JSON.stringify({ error: '导入 srt 失败（importFiles 返回 false）' });
        }

        // 3. 按路径找回刚导入的 ProjectItem
        var projectItem = null;
        try {
            var found = app.project.rootItem.findItemsMatchingMediaPath(tmpFile.fsName, 1);
            if (found && found.length !== undefined && found.length > 0) {
                projectItem = found[0];
            } else if (found && found.length === undefined) {
                projectItem = found;
            }
        } catch (e) {}
        if (!projectItem) {
            return JSON.stringify({ error: '导入成功但未找到 ProjectItem（findItemsMatchingMediaPath 无结果）' });
        }

        // 4. 创建字幕轨（整序列混音后时间已对齐，startAtTime 恒为 0.0）
        // 若目标序列非当前激活，先打开它（caption track 创建依赖序列处于激活状态）
        try {
            if (app.project.activeSequence && app.project.activeSequence.sequenceID !== seq.sequenceID) {
                app.project.openSequence(seq.sequenceID);
            }
        } catch (e) {}
        var result = seq.createCaptionTrack(projectItem, 0.0);
        return JSON.stringify({ ok: true, result: String(result), fileName: fileName });
    } catch (e) {
        return JSON.stringify({ error: '回写失败: ' + e.toString() });
    }
}

// ---------- 读取序列片段（三种识别基准）----------
// mode: 'all' 整轴 | 'inout' 出入点区间 | 'selection' 选中块
function wsGetSequenceClipsRange(seqId, mode) {
    try {
        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var clips = [];
        var i, j;

        if (mode === 'selection') {
            var sel = seq.getSelection();
            if (!sel || sel.length === 0) {
                return JSON.stringify({ error: '当前序列没有选中的片段，请先在时间轴选中音频/视频块' });
            }
            for (i = 0; i < sel.length; i++) {
                var sc = sel[i];
                var sp = getClipMediaPath(sc);
                if (!sp) continue;
                var sip = sc.inPoint ? sc.inPoint.seconds : 0;
                var sop = sc.outPoint ? sc.outPoint.seconds : 0;
                clips.push({
                    mediaPath: sp,
                    seqStart: sc.start ? sc.start.seconds : 0,
                    inPoint: sip,
                    outPoint: sop,
                    duration: sop - sip,
                    trackType: 'audio',
                    clipName: sc.name || ''
                });
            }
            if (clips.length === 0) return JSON.stringify({ error: '选中的片段没有可用的媒体路径' });
            return JSON.stringify({
                clips: clips,
                seqName: seq.name,
                seqEnd: seq.end.seconds,
                sourceTrack: 'audio',
                mode: 'selection'
            });
        }

        // all / inout
        var inSec = -1, outSec = -1;
        if (mode === 'inout') {
            // getInPoint() / getOutPoint() 返回 Real（秒），不是 Time 对象
            try { inSec = seq.getInPoint(); } catch (e) {}
            try { outSec = seq.getOutPoint(); } catch (e) {}
            if (inSec < 0 || outSec <= inSec) {
                return JSON.stringify({ error: '无法读取序列出入点，请先在时间轴设置入点(I)和出点(O)' });
            }
        }

        var audioClips = [], videoClips = [];
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            var atr = seq.audioTracks[i];
            for (j = 0; j < atr.clips.numItems; j++) {
                var aclip = atr.clips[j];
                var aMediaPath = getClipMediaPath(aclip);
                if (!aMediaPath) continue;
                var ast = aclip.start.seconds;
                var adur = aclip.outPoint.seconds - aclip.inPoint.seconds;
                if (mode === 'inout' && (ast + adur <= inSec || ast >= outSec)) continue;
                audioClips.push({
                    mediaPath: aMediaPath,
                    seqStart: ast,
                    inPoint: aclip.inPoint.seconds,
                    outPoint: aclip.outPoint.seconds,
                    duration: adur,
                    trackType: 'audio',
                    clipName: aclip.name
                });
            }
        }
        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            var vtr = seq.videoTracks[i];
            for (j = 0; j < vtr.clips.numItems; j++) {
                var vclip = vtr.clips[j];
                var vMediaPath = getClipMediaPath(vclip);
                if (!vMediaPath) continue;
                var vst = vclip.start.seconds;
                var vdur = vclip.outPoint.seconds - vclip.inPoint.seconds;
                if (mode === 'inout' && (vst + vdur <= inSec || vst >= outSec)) continue;
                videoClips.push({
                    mediaPath: vMediaPath,
                    seqStart: vst,
                    inPoint: vclip.inPoint.seconds,
                    outPoint: vclip.outPoint.seconds,
                    duration: vdur,
                    trackType: 'video',
                    clipName: vclip.name
                });
            }
        }

        if (audioClips.length > 0) clips = audioClips;
        else clips = videoClips;

        if (clips.length === 0) {
            if (mode === 'inout') return JSON.stringify({ error: '出入点区间内没有可识别的音视频片段' });
            return JSON.stringify({ error: '序列里没有可识别的音视频片段' });
        }

        return JSON.stringify({
            clips: clips,
            seqName: seq.name,
            seqEnd: seq.end.seconds,
            sourceTrack: audioClips.length > 0 ? 'audio' : 'video',
            mode: mode
        });
    } catch (e) {
        return JSON.stringify({ error: '读取序列失败: ' + e.toString() });
    }
}

// ---------- 导入文件到指定素材箱（从全局变量读文件列表，避开 evalScript 转义地狱）----------
function wsImportToBinStr(binName) {
    try {
        var files = wsImportToBinPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === binName) { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin(binName); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: binName, imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入素材箱失败: ' + e.toString() });
    }
}

function wsGetAllSequencesStr() { return wsGetAllSequences(); }
function wsGetSequenceClipsStr(seqId) { return wsGetSequenceClips(seqId); }
function wsGetSequenceClipsRangeStr(seqId, mode) { return wsGetSequenceClipsRange(seqId, mode); }
function wsWriteBackStr(seqId) { return wsWriteBack(seqId); }
