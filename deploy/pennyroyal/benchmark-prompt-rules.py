"""Paired first-attempt prompt screening; execute candidates only in Docker.

No production prompts, cache, service settings, or model weights are changed.
Usage: --self-test first; then --url ... --output /outside/repository/report.json.
Requires a local Docker daemon and python:3.9-slim-bookworm.
"""
import argparse
import hashlib
import json
import math
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

BASE = "你是编程助手。按用户要求完成代码，严格遵守指定的输出格式。"
RULES = """
执行规则：
- 按任务给定的解释器版本编写，不假设新版本语法可用。
- 减少跨语言嵌套和转义层数；传数据优先参数或标准输入，不把数据拼成代码。
- Shell 中按字面量处理的数据须正确引用；嵌入长代码优先使用带引号的 heredoc。
- 输出前静默核对引号、括号、反斜杠、变量拼写和边界条件，只输出最终代码。
- 不声称执行过没有实际执行的测试。
""".strip()
IMAGE = "python:3.9-slim-bookworm"


def cases():
    result = []

    def py(name, spec, reference, tests):
        result.append(dict(id=name, lang="python", prompt="只输出可运行于Python 3.9的源码，不要Markdown或解释。只定义要求的函数，可使用标准库。\n" + spec,
                           reference=reference, tests=tests))

    def sh(name, spec, reference, tests):
        result.append(dict(id=name, lang="bash", prompt="只输出Bash 5.2脚本源码，不要Markdown或解释。环境有python3（3.9）与Debian标准命令。不访问网络、不创建持久文件。\n" + spec,
                           reference=reference, tests=tests))

    py("literal_backslashes", "定义solve(s)：一次性把每两个连续反斜杠替换成一个；从左到右不重叠，奇数个留下末尾一个。其他字符原样保留。",
       'def solve(s):\n    return s.replace("\\\\\\\\", "\\\\")\n',
       [["abc", "abc"], ["a" + "\\" * 5 + "n", "a" + "\\" * 3 + "n"], ["\\" * 2 + "t\\n", "\\t\\n"]])
    py("literal_eval", "定义solve(s)：用ast.literal_eval解析字符串。成功返回值；任何解析失败返回{'error':'invalid'}，不得执行表达式。",
       "import ast\ndef solve(s):\n    try: return ast.literal_eval(s)\n    except (ValueError, SyntaxError, TypeError): return {'error':'invalid'}\n",
       [["{'a': [True, None, 3]}", {"a": [True, None, 3]}], ["[", {"error": "invalid"}], ["1+2", {"error": "invalid"}]])
    py("identifier", "定义solve(names)：保持首次出现顺序去重，只保留str.isidentifier为真且不是Python3.9关键字的字符串。",
       "import keyword\ndef solve(names):\n    return list(dict.fromkeys(n for n in names if n.isidentifier() and not keyword.iskeyword(n)))\n",
       [[["def", "x", "x", "match", "2x"], ["x", "match"]], [["变量", "_", "None", "a-b"], ["变量", "_"]], [[], []]])
    py("quoted_url", "定义solve(text)：提取第一个完整的PAY_URL赋值。格式PAY_URL后可有空白，然后=，可有空白，然后单或双引号包围值；结束引号必须和开始相同，值可含另一种引号但没有转义。返回'url='+提取值，没有匹配则返回'url='。",
       'import re\ndef solve(text):\n    m = re.search(r"PAY_URL\\s*=\\s*([\\\'\\\"])(.*?)\\1", text)\n    return "url=" + (m.group(2) if m else "")\n',
       [["PAY_URL = \"a'b\";", "url=a'b"], ["PAY_URL=''; PAY_URL='x'", "url="], ["PAY_URL='broken\"", "url="]])
    py("json_line", "定义solve(x)：输入字典含user_name、userName、user__name三个字符串，返回紧凑JSON字符串，键顺序固定为snake、camel、double，分别取对应输入值，保持Unicode不转义。",
       'import json\ndef solve(x):\n    return json.dumps(dict(snake=x["user_name"], camel=x["userName"], double=x["user__name"]), ensure_ascii=False, separators=(",", ":"))\n',
       [[dict(user_name="张三", userName='a"b', user__name="\\n"), '{"snake":"张三","camel":"a\\\"b","double":"\\\\n"}'],
        [dict(user_name="", userName="\n", user__name="'"), '{"snake":"","camel":"\\n","double":"\'"}']])
    py("literal_regex", "定义solve(s)：计算字面字符序列反斜杠紧跟w的出现次数（不是正则的单词字符类别）。反斜杠不作为转义处理，连续两个反斜杠后w也算1次。",
       'def solve(s):\n    return s.count("\\\\w")\n',
       [[r"\word \w \w\w", 4], ["w \\" + "w", 1], ["", 0], ["\\" * 2 + "w", 1]])
    needle = "price`raw`=$HOME\\data"
    sh("grep_literal", "从标准输入逐行读取，原样输出包含下列字面字符串的行：" + repr(needle) + "。这是Python repr表示法，反斜杠转义只用于展示。无匹配退出0。不能把反引号或$当命令/变量执行。",
       "grep -F 'price`raw`=$HOME\\data' || test \"$?\" -eq 1\n",
       [["x " + needle + " y\nprice raw\n", "x " + needle + " y\n"], ["nothing\n", ""]])
    literal = "a'b\"c\\d $HOME `printf BAD` $(printf BAD)"
    sh("printf_literal", "不读输入。只输出这一行字面文本及一个换行，不展开任何内容：\n" + literal,
       "printf '%s\\n' 'a'\"'\"'b\"c\\d $HOME `printf BAD` $(printf BAD)'\n", [["", literal + "\n"]])
    sh("python_argument", "第一个命令行参数是任意字符串。调用python3输出一个JSON字符串字面量表示该参数，ensure_ascii=False。保留引号、反斜杠和换行；输出结尾有一个换行。",
       "python3 -c 'import json,sys; print(json.dumps(sys.argv[1],ensure_ascii=False))' \"$1\"\n",
       [["", json.dumps("a'\"\\\n$HOME`x`", ensure_ascii=False) + "\n", ["a'\"\\\n$HOME`x`"]], ["", '"中文"\n', ["中文"]]])
    source = 'def show():\n    print("$HOME `date` \\\\n")\n'
    sh("heredoc_literal", "只向标准输出输出以下Python源码（含末尾换行），不执行它；保留所有字面符号：\n" + source,
       "cat <<'PY_SOURCE'\n" + source + "PY_SOURCE\n", [["", source]])
    sh("argument_lines", "把所有命令行参数各输出一行，保持参数内容完全不变。没有参数时输出空内容。参数可以是-n、包含空格、引号或反斜杠。",
       'for arg in "$@"; do printf "%s\\n" "$arg"; done\n',
       [["", "", []], ["", "-n\na b\n\\n\n\"'\n", ["-n", "a b", "\\n", "\"'"]]])
    sh("stdin_json", "从标准输入读取完整文本（包括末尾换行），通过python3输出紧凑JSON对象{\"text\":原文本,\"length\":Unicode字符数}，键顺序如示，ensure_ascii=False。只能输出该JSON和末尾换行。",
       'python3 -c \'import sys,json; s=sys.stdin.read(); print(json.dumps({"text":s,"length":len(s)},ensure_ascii=False,separators=(",",":")))\'\n',
       [[s, json.dumps(dict(text=s, length=len(s)), ensure_ascii=False, separators=(",", ":")) + "\n"] for s in ("", "张三\n", "a'\"\\\n$HOME")])
    # Ordinary functional controls, not just the errors targeted by the rules.
    py("control_intervals", "定义solve(intervals)：输入若干[start,end]表示左闭右开非空整数区间，排序并只合并实际重叠，首尾相接不合并。返回二维列表。",
       'def solve(intervals):\n    out=[]\n    for a,b in sorted(intervals):\n        if out and a<out[-1][1]: out[-1][1]=max(b,out[-1][1])\n        else: out.append([a,b])\n    return out\n',
       [[[[1,4],[4,7],[2,3],[6,9]], [[1,4],[4,9]]], [[], []], [[[2,5],[1,8]], [[1,8]]]])
    py("control_sort", "定义solve(rows)：每项含id、priority、created。按priority降序，再created升序，完全相同保留原顺序，返回id列表。",
       'def solve(rows):\n    return [r["id"] for r in sorted(rows,key=lambda r:(-r["priority"],r["created"]))]\n',
       [[[dict(id="a",priority=2,created=3),dict(id="b",priority=3,created=5),dict(id="c",priority=2,created=3)], ["b","a","c"]], [[], []]])
    py("control_runs", "定义solve(values)：对相邻相同整数进行游程编码，返回[[值,连续次数],...]，不合并不相邻的相同值。",
       'def solve(values):\n    out=[]\n    for v in values:\n        if out and out[-1][0]==v: out[-1][1]+=1\n        else: out.append([v,1])\n    return out\n',
       [[[1,1,2,1], [[1,2],[2,1],[1,1]]], [[], []], [[0,0,-1,-1,-1], [[0,2],[-1,3]]]])
    py("control_rotation", "定义solve(x)：x为{items:整数列表,k:任意整数}。返回items向右循环移动k位后的新列表，k为负表示左移，空列表返回空列表。",
       'def solve(x):\n    a=x["items"]\n    if not a: return []\n    k=x["k"]%len(a)\n    return a[-k:]+a[:-k] if k else a[:]\n',
       [[dict(items=[1,2,3],k=-1), [2,3,1]], [dict(items=[],k=5), []], [dict(items=[1,2],k=4), [1,2]]])
    return result


# The candidate never runs on the host. No credentials, network, or writable
# host mounts enter the container. Resource limits also apply to subprocesses.
RUNNER = r'''
import ast,json,subprocess,sys
p=json.load(sys.stdin); code=p['code']; lang=p['lang']; tests=p['tests']
path='/tmp/candidate.'+('py' if lang=='python' else 'sh')
open(path,'w').write(code)
try:
 if lang=='python': ast.parse(code,feature_version=9)
 else:
  r=subprocess.run(['bash','-n',path],capture_output=True,text=True,timeout=3)
  if r.returncode: raise SyntaxError(r.stderr[:500])
except Exception as e:
 print(json.dumps({'syntax':False,'passed':False,'error':str(e)[:500]}));sys.exit()
results=[]
for t in tests:
 try:
  if lang=='python':
   wrapper="import json,runpy,sys; ns=runpy.run_path('/tmp/candidate.py'); print(json.dumps(ns['solve'](json.loads(sys.stdin.read())),ensure_ascii=False))"
   r=subprocess.run([sys.executable,'-I','-c',wrapper],input=json.dumps(t[0]),capture_output=True,text=True,timeout=3)
   ok=r.returncode==0 and json.loads(r.stdout)==t[1]
  else:
   r=subprocess.run(['bash','--noprofile','--norc',path]+(t[2] if len(t)>2 else []),input=t[0],capture_output=True,text=True,timeout=3)
   ok=r.returncode==0 and r.stdout==t[1]
  results.append({'ok':ok,'stderr':r.stderr[:300],'stdout':r.stdout[:500],'returncode':r.returncode})
 except Exception as e:results.append({'ok':False,'error':str(e)[:300]})
print(json.dumps({'syntax':True,'passed':all(x['ok'] for x in results),'tests':results}))
'''


def evaluate(case, code, image):
    command = ['docker', 'run', '--rm', '-i', '--network=none', '--read-only',
               '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
               '--memory=256m', '--cpus=1', '--pids-limit=32', '--ulimit=fsize=1048576:1048576',
               '--tmpfs=/tmp:rw,nosuid,size=8m', image, 'python3', '-I', '-c', RUNNER]
    r = subprocess.run(command, input=json.dumps(dict(code=code, lang=case['lang'], tests=case['tests'])),
                       text=True, capture_output=True, timeout=25)
    if r.returncode:
        raise RuntimeError('Oracle container failed: ' + r.stderr[:500])
    return json.loads(r.stdout)


def request(url, case, arm, repeat):
    body = dict(model='pennyroyal', messages=[dict(role='system', content=BASE + ('\n' + RULES if arm == 'rules' else '')),
                dict(role='user', content=case['prompt'])], temperature=1, seed=4200 + repeat,
                max_tokens=8192, stream=False, chat_template_kwargs=dict(enable_thinking=True, reasoning_effort='medium'))
    req = urllib.request.Request(url.rstrip('/') + '/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    start = time.monotonic()
    with urllib.request.urlopen(req, timeout=180) as response:
        data = json.load(response)
    elapsed = time.monotonic() - start
    choice = data['choices'][0]
    return dict(id=case['id'], arm=arm, repeat=repeat, seed=4200+repeat, elapsed_s=elapsed,
                usage=data.get('usage'), finish_reason=choice['finish_reason'], message=choice['message'])


def summarize(runs):
    summary = {}
    for arm in ('baseline', 'rules'):
        rows = [r for r in runs if r['arm'] == arm]
        if not rows:
            continue
        summary[arm] = dict(total=len(rows), passed=sum(r['passed'] for r in rows),
                            syntax_passed=sum(r.get('oracle', {}).get('syntax', False) for r in rows),
                            median_s=statistics.median(r['elapsed_s'] for r in rows),
                            total_s=sum(r['elapsed_s'] for r in rows),
                            completion_tokens=sum((r.get('usage') or {}).get('completion_tokens', 0) for r in rows),
                            failures=[r['id']+':'+str(r['repeat']) for r in rows if not r['passed']])
    pairs = {}
    for r in runs:
        pairs.setdefault((r['id'],r['repeat']), {})[r['arm']] = r['passed']
    both = [v for v in pairs.values() if len(v) == 2]
    wins = sum(v['rules'] and not v['baseline'] for v in both)
    losses = sum(v['baseline'] and not v['rules'] for v in both)
    n = wins+losses
    summary['paired'] = dict(wins=wins, losses=losses, ties=len(both)-n,
        exploratory_sign_p=min(1,2*sum(math.comb(n,k) for k in range(min(wins,losses)+1))/2**n) if n else 1)
    # Repeated samples of the same task are not independent task-level evidence.
    task_scores = {}
    for (case_id, _), pair in pairs.items():
        if len(pair) != 2:
            continue
        scores = task_scores.setdefault(case_id, {'baseline':0, 'rules':0})
        for arm in scores:
            scores[arm] += int(pair[arm])
    tw = sum(v['rules']>v['baseline'] for v in task_scores.values())
    tl = sum(v['rules']<v['baseline'] for v in task_scores.values())
    tn = tw+tl
    summary['task_level'] = dict(wins=tw, losses=tl, ties=len(task_scores)-tn,
        exploratory_sign_p=min(1,2*sum(math.comb(tn,k) for k in range(min(tw,tl)+1))/2**tn) if tn else 1)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    image = subprocess.check_output(['docker','image','inspect',IMAGE,'--format','{{.Id}}'],text=True).strip()
    suite = cases()
    if args.self_test:
        for c in suite:
            r = evaluate(c,c['reference'],image)
            assert r['passed'], (c['id'],r)
            wrong = 'def solve(x):\n    return "wrong"\n' if c['lang']=='python' else 'printf wrong\n'
            assert not evaluate(c,wrong,image)['passed'], c['id']
            print(c['id'], 'reference PASS, wrong-output REJECT', flush=True)
        return
    if not args.url or not args.output:
        parser.error('--url and --output are required for a measured run')
    if args.output.exists():
        parser.error('output exists; use a fresh path to preserve previous runs')
    manifest = dict(base=BASE,rules=RULES,cases=suite,seeds=[4200,4201],temperature=1,max_tokens=8192,
                    reasoning_effort='medium', image=image, cache='not flushed', request_concurrency=1,
                    decision='screening only; no automatic deployment; require replicated gains on at least two tasks, no regressions, then fresh holdout before adoption',
                    limitations='Not full Pi harness; no neutral length-matched prompt; small targeted sample; latency affected by shared production traffic/cache')
    report = dict(manifest=manifest, manifest_sha256=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),runs=[])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    for repeat in range(2):
        for index,c in enumerate(suite):
            for arm in (('baseline','rules') if (index+repeat)%2==0 else ('rules','baseline')):
                r=request(args.url,c,arm,repeat)
                code=r['message'].get('content') or ''
                r['oracle']=evaluate(c,code,image)
                r['passed']=r['oracle']['passed'] and r['finish_reason']=='stop'
                report['runs'].append(r)
                report['summary']=summarize(report['runs'])
                args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                print(json.dumps({k:r[k] for k in ('id','arm','repeat','passed','elapsed_s','finish_reason')}),flush=True)
    print(json.dumps(report['summary'],ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
