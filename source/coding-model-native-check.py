#!/usr/bin/env python3
"""Compile and execute the actual worktree request policy, without an app or bridge."""
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).with_name('Tools.swift').read_text()
start = source.index('enum CodingWorktreePolicy {')
end = source.index('    private static func text(', start)
policy = source[start:end] + '}\n'
fixture = r'''
import Foundation
import CoreFoundation
// POLICY
let id = "97D9B831-0F4B-4692-ADBF-33D1E350A8ED"
let base: [String:Any] = ["action":"open","id":id,"provider":"local"]
func with(_ extras: [String:Any]) -> [String:Any] {base.merging(extras) {_,new in new}}
precondition(CodingWorktreePolicy.action(base)=="open")
precondition(CodingWorktreePolicy.action(with(["model":"local/alternate-65k"]))=="open")
precondition(CodingWorktreePolicy.action(with(["model":String(repeating:"a",count:200)]))=="open")
for bad: Any in ["", "  ", "bad\nmodel", "bad\u{7f}model", String(repeating:"a",count:201), false, 3, NSNull()] {
  precondition(CodingWorktreePolicy.action(with(["model":bad]))==nil)
}
precondition(CodingWorktreePolicy.action(with(["provider":"cloud","model":"alternate"]))==nil)
precondition(CodingWorktreePolicy.action(with(["provider":"cloud"]))=="open")
precondition(CodingWorktreePolicy.action(with(["model":"alternate","endpoint":"https://example.com"]))==nil)
precondition(CodingWorktreePolicy.action(["action":"open","id":id,"model":"alternate"])==nil)
precondition(CodingWorktreePolicy.action(with(["id":"bad"]))==nil)
precondition(CodingWorktreePolicy.action(["action":"list"])=="list")
precondition(CodingWorktreePolicy.action(["action":"list","model":"alternate"])==nil)
let creation: [String:Any] = ["action":"create","cwd":"/fixture","ref":"HEAD"]
precondition(CodingWorktreePolicy.action(creation)=="create")
for value in [false,true] {precondition(CodingWorktreePolicy.action(creation.merging(["copyChanges":value]){_,new in new})=="create")}
for value:Any in [0,1,"true",NSNull()] {precondition(CodingWorktreePolicy.action(creation.merging(["copyChanges":value]){_,new in new})==nil)}
print("PASS: actual native worktree policy accepts exact model and explicit boolean copy mode; malformed/cloud/unknown fields rejected")
'''.replace('// POLICY', policy)
with tempfile.TemporaryDirectory(prefix='saleh-model-native-') as folder:
    swift = Path(folder) / 'Check.swift'
    swift.write_text(fixture)
    binary = Path(folder) / 'check'
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(Path(folder) / 'module-cache'), str(swift), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
