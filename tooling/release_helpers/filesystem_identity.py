"""Exact filesystem_identity function extracted from the pinned Build88 helper.

The host adapter supplies the already digest-checked Node executable and require.
The original function body is unchanged; see PROVENANCE.json.
"""
import json
import subprocess

NODE = None
require = None

def filesystem_identity(h,stage,helper,expected):
    script = 'const {readFilesystemIdentity}=await import(process.argv[1]);console.log(JSON.stringify(await readFilesystemIdentity({path:process.argv[2],nativeHelper:process.argv[3]})));'
    before = h['identity'](h['CODING']); result = subprocess.run([NODE,'--input-type=module','-e',script,(stage/'source/filesystem-identity.mjs').as_uri(),str(h['CODING']),str(helper)],capture_output=True,text=True,timeout=15,check=True)
    require(json.loads(result.stdout) == {'volumeUUID':expected['volumeUUID'],'ino':expected['ino']} and before == h['identity'](h['CODING']) and all(before[key] == expected[key] for key in ('path','ino','uid')), 'Fresh native Coding identity differs')
