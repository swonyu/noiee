#!/usr/bin/env python3
from pathlib import Path
import subprocess,tempfile,re,json
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='noiee-launch-compile-') as tmp:
    binary=Path(tmp)/'check'
    subprocess.run(['/usr/bin/xcrun','swiftc',*[str(root/'source'/name) for name in ['CodingTemporary.swift','ExternalToolInstall.swift','ExternalToolLaunch.swift']],str(root/'tooling/tests/ExternalToolLaunchFixture.swift'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
    with tempfile.TemporaryDirectory(prefix='noiee-review-parity-',dir=Path.home()/'Library/Caches') as parent:
        script="""
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const {ExternalToolRuntime}=await import(process.argv[1]);const parent=process.argv[2],source=Buffer.from('throw Error("never executed parity artifact");'),hash=v=>createHash('sha256').update(v).digest('hex'),revision=hash(source),base=path.join(parent,'external-tools-v1','revisions',revision);
fs.mkdirSync(base,{recursive:true,mode:0o700});fs.writeFileSync(path.join(base,'artifact.mjs'),source,{mode:0o400});fs.writeFileSync(path.join(base,'receipt.json'),JSON.stringify({version:1,kind:'inert-external-js-install',operationId:randomUUID(),generation:randomUUID(),url:'https://raw.githubusercontent.com/fixture/repo/'+'a'.repeat(40)+'/x.mjs',sha256:revision,bytes:source.length,purpose:'Parity fixture',sourceTrust:'unreviewed-external',launch:'never-started'}),{mode:0o400});
let manager;const hub={describe:async()=>({servers:manager.managedExternal().map(({id,config})=>({id,configHash:hash(JSON.stringify(config))}))})};manager=new ExternalToolRuntime({parent,hub,authority:{},unconfinedBoot:true,recoveryStartup:false,assertUnconfinedAccess:async()=>{}});const review=await manager.prepare({revision});fs.writeFileSync(path.join(parent,'review.json'),JSON.stringify(review));process.stdout.write(revision);
"""
        revision=subprocess.check_output(['/opt/homebrew/bin/node','--input-type=module','-e',script,(root/'source/external-tool-runtime.mjs').as_uri(),parent],text=True)
        subprocess.run([str(binary),'--validate-review',str(Path(parent)/'review.json'),str(root/'source/runtime-contract.json'),parent,revision],check=True)
s=(root/'source/Tools.swift').read_text()
assert 'button:"Connect once",expected:expected,operational:false' in s
assert 'externalLaunch.invalidate()' in s and s.count('externalLaunch.drain()')==2
js=(root/'source/external-tool-runtime.mjs').read_text();swift=(root/'source/ExternalToolLaunch.swift').read_text()
assert re.search(r'export const EXTERNAL_JS_LOADER = `([^`]+)`',js).group(1)==re.search(r'static let loader="([^"\n]+)"',swift).group(1)
print(json.dumps({'nativeMandatoryLaunchReview':True,'fixedLoaderParity':True,'ownedStopAndDrain':True}))
