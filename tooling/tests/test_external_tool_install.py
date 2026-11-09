#!/usr/bin/env python3
"""Compile/run only disposable native external-artifact checks. No UI/network/model."""
from pathlib import Path
import subprocess, tempfile, json
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='noiee-external-compile-') as tmp:
    binary=Path(tmp)/'check'
    subprocess.run(['/usr/bin/xcrun','swiftc',str(root/'source/CodingTemporary.swift'),str(root/'source/ExternalToolInstall.swift'),str(root/'tooling/tests/ExternalToolInstallFixture.swift'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
source=(root/'source/Tools.swift').read_text()
assert 'button:"Install inert file once",expected:expected,operational:false' in source
assert 'externalTools.invalidate()' in source and source.count('externalTools.drain()')==2
assert 'performExternalArtifact(arguments,expected:expected,beforeEffect:beforeEffect,agentClaim:agentClaim)' in source
print(json.dumps({'nativeMandatoryApprovalRouting':True,'stopOwnership':True,'noExternalRuntimeExecuted':True}))
