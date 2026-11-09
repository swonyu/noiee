#!/usr/bin/env python3
"""Execute the actual native restore approval text with no app or live stores."""
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).with_name('Tools.swift').read_text()
start = source.index('    static func restoreEffect(')
end = source.index('    private static func text(', start)
policy = 'enum CodingWorktreePolicy {\n' + source[start:end] + '}\n'
# Ensure the tested renderer is the one used before the native approval/dispatch.
worktrees = source[source.index('    private func worktrees('):]
renderer = worktrees.index('guard let restoreEffect=CodingWorktreePolicy.restoreEffect(plan)')
assert renderer < worktrees.index('effect=restoreEffect', renderer) < worktrees.index('guard try await approve(title,detail:detail+')
assert 'The checkout is detached; existing branches stay unchanged.' not in worktrees
fixture = r'''
import Foundation
// POLICY
var checks=0
func verify(_ condition:Bool,_ name:String) {precondition(condition,name);checks+=1;print("PASS \(name)")}
func render(_ ref:Any,_ warning:Any=NSNull()) -> String? {CodingWorktreePolicy.restoreEffect(["headRef":ref,"warning":warning])}
for ref in ["refs/heads/work", "refs/heads/work/مرحبا", "refs/heads/--force", "refs/heads/HEAD"] {
    let effect=render(ref)!
    verify(effect.contains("attached to its saved branch \(ref)") && effect.contains("later commits will advance that branch") && effect.contains("Restore is refused if the branch moved, is missing or is checked out elsewhere.") && !effect.contains("detached"),"attached approval \(ref)")
}
let detached=render(NSNull())!
verify(detached.contains("will remain detached") && detached.contains("branch tips stay unchanged") && !detached.contains("legacy") && !detached.contains("advance"),"detached approval")
let legacyWarning="Legacy archive did not record branch attachment; it will restore detached."
let legacy=render(NSNull(),legacyWarning)!
verify(legacy.contains("original branch attachment cannot be reconstructed") && legacy.contains("will restore detached") && !legacy.contains("advance"),"legacy limitation is visible")
for effect in [render("refs/heads/work")!,detached,legacy] {
    verify(effect.contains("committed HEAD and staging") && effect.contains("original path must be absent") && effect.contains("project access is reviewed again") && effect.contains("recovery bundle is retained"),"shared restore effects retained")
}
for ref:Any in [true,123,"","refs/heads/","refs/tags/work","refs/heads/bad\nref","refs/heads/bad\u{01}ref","refs/heads/bad ref","refs/heads/a..b","refs/heads/a@{b","refs/heads/a.lock","refs/heads/.hidden","refs/heads/a//b","refs/heads/a.","refs/heads/a\\b","refs/heads/a?b",String(repeating:"a",count:8001)] {
    verify(render(ref)==nil,"invalid branch metadata refused")
}
for warning:Any in [false,0,"",legacyWarning,"arbitrary warning"] {
    verify(render("refs/heads/work",warning)==nil,"attached warning conflict refused")
}
for warning:Any in [false,0,"","arbitrary warning"] {verify(render(NSNull(),warning)==nil,"unknown detached warning refused")}
for plan:[String:Any] in [[:],["headRef":NSNull()],["warning":NSNull()],["headRef":"refs/heads/work"]] {
    verify(CodingWorktreePolicy.restoreEffect(plan)==nil,"missing restore metadata refused")
}
print("PASS: \(checks) native restore approval assertions; no app or live store opened")
'''.replace('// POLICY', policy)
with tempfile.TemporaryDirectory(prefix='noiee-restore-native-') as folder:
    swift = Path(folder) / 'Check.swift'
    swift.write_text(fixture)
    binary = Path(folder) / 'check'
    subprocess.run(['/usr/bin/xcrun','swiftc','-module-cache-path',str(Path(folder)/'module-cache'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
