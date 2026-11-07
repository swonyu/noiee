"""Native pre-boot gate check. Uses disposable sparse stubs; never releases a valid VM."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import uuid

binary = str(Path(sys.argv[1]).resolve())
owner, generation = str(uuid.uuid4()), str(uuid.uuid4())
groups = []


def fixture(root):
    root.chmod(0o700)
    data = dict(version=1, guestId=str(uuid.uuid4()).upper(), controller='fixture', build='test',
                macAddress='02:00:00:00:00:01', cpu=4, memoryBytes=4*1024**3,
                diskBytes=64*1024**3, directoryShares=0)
    for name, value in [('fixture.json', data), ('installed.json', dict(build='test', controller='fixture', installed=True, state='stopped'))]:
        (root/name).write_text(json.dumps(value))
    for name in ['hardware-model.bin', 'machine-id.bin', 'auxiliary.bin']:
        (root/name).write_bytes(b'stub')
    with (root/'disk.img').open('wb') as stream:
        stream.truncate(64*1024**3)
    for path in root.iterdir():
        path.chmod(0o600)


def launch(root, owner_id=owner):
    return subprocess.Popen([binary, str(root), owner_id, generation], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)


def claimed(child):
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(8), 'Native controller did not expose a pre-boot claim'
        line = child.stdout.readline()
    if not line:
        out,err=child.communicate(timeout=3)
        raise AssertionError(('Native controller exited without the required pre-boot owner claim',child.returncode,err.decode()))
    row = json.loads(line)
    assert row['event'] == 'claimed', row
    return row


os.umask(0o077)
for mode in ['stop', 'eof', 'stop-after-ack', 'eof-after-ack', 'signal', 'wrong-ack', 'replaced-artifact', 'changed-artifact']:
    with tempfile.TemporaryDirectory(prefix='saleh-vm-claim-', dir='/private/tmp') as temp:
        root = Path(temp)
        fixture(root)
        child = launch(root)
        try:
            event = claimed(child)
            raw = (root/'boot-claim.json').read_bytes()
            claim = json.loads(raw)
            digest = hashlib.sha256(raw).hexdigest()
            assert event['claimSHA256'] == digest
            assert (claim['ownerId'], claim['generation']) == (owner, generation)
            assert claim['process']['pid'] == claim['process']['pgid'] == child.pid
            assert claim['process']['nonce'] == generation
            assert claim['parent']['pid'] == os.getpid()
            for process in [claim['process'], claim['parent']]:
                assert process['uid'] == os.getuid() and process['version'] == 1
                assert int(process['startSec']) > 0 and 0 <= process['startUsec'] < 1000000
                uuid.UUID(process['bootSession'])
            assert claim['root']['ino'] == str(root.stat().st_ino)
            assert set(claim['artifacts']) == {'fixture.json', 'installed.json', 'disk.img', 'auxiliary.bin', 'hardware-model.bin', 'machine-id.bin'}
            assert claim['artifacts']['disk.img']['size'] == str(64*1024**3)
            assert not (root/'boot-terminal.json').exists() and child.poll() is None
            if mode == 'stop':
                command = b'stop\n'
            elif mode == 'eof':
                command = b''
            elif mode in ('stop-after-ack', 'eof-after-ack'):
                command = ('start '+digest+'\n').encode() + (b'stop\n' if mode == 'stop-after-ack' else b'')
            elif mode == 'signal':
                child.terminate()
                command = b''
            elif mode == 'wrong-ack':
                command = b'start '+b'0'*64+b'\n'
            else:
                path = root/'machine-id.bin'
                if mode == 'replaced-artifact':
                    path.unlink()
                path.write_bytes(b'changed')
                path.chmod(0o600)
                command = ('start '+digest+'\n').encode()+b'A'*48+b'\n'
            out, err = child.communicate(command, timeout=12)
            events = [json.loads(line) for line in out.splitlines()]
            assert not any(e['event'] in ('boot-start', 'running') for e in events), events
            assert not err, err
            if mode in ('stop', 'eof', 'stop-after-ack', 'eof-after-ack', 'signal'):
                terminal = json.loads((root/'boot-terminal.json').read_text())
                assert terminal['ownerId'] == owner and terminal['generation'] == generation
                assert terminal['claimSHA256'] == digest and terminal['cancelledBeforeBoot'] is True
                assert terminal['closureConfirmed'] is True and terminal['started'] is False
                assert type(terminal['faulted']) is bool, 'Native terminal faulted must be a JSON boolean'
                assert child.returncode == (0 if mode in ('stop', 'stop-after-ack') else 1)
            else:
                assert child.returncode == 1 and any(e['event'] == 'failed' for e in events), events
            again = subprocess.run([binary, str(root), owner, generation], input=b'', capture_output=True, timeout=8, start_new_session=True)
            assert again.returncode == 1 and b'A claimed execution epoch cannot be restarted' in again.stdout
            assert (root/'boot-claim.json').read_bytes() == raw
            groups.append(mode)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)

with tempfile.TemporaryDirectory(prefix='saleh-vm-claim-', dir='/private/tmp') as temp:
    root = Path(temp)
    fixture(root)
    child = launch(root, 'invalid-owner')
    out, err = child.communicate(b'', timeout=8)
    assert child.returncode != 0 and not (root/'boot-claim.json').exists()
    groups.append('invalid-owner')
# Two distinct phases share the allocator's open descriptor and lock. Stubs are
# never released; successful provisioning below is synthetic gate-test data.
for mode in ['retained-lock','execute-stop','graceful-provision-stop','wrong-parent','changed-disk','changed-metadata','missing-pin','wrong-descriptor','closed-descriptor','malformed-number']:
    with tempfile.TemporaryDirectory(prefix='saleh-vm-phase-', dir='/private/tmp') as temp:
        root=Path(temp);fixture(root);fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        def phase(kind,descriptor=fd):
            return subprocess.Popen([binary,str(root),owner,generation,kind,str(descriptor)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,pass_fds=(fd,))
        try:
            child=phase('provision');event=claimed(child);out,err=child.communicate(b'stop\n',timeout=8)
            assert child.returncode==0 and not err
            raw=(root/'provision-claim.json').read_bytes();claim=json.loads(raw)
            assert claim['trustedProvisioningOnly'] is True and claim['executionAdmitted'] is False and not (root/'boot-claim.json').exists()
            independent=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            try:
                try:fcntl.flock(independent,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:pass
                else:raise AssertionError('Allocator lock was released with the provisioning child')
            finally:os.close(independent)
            if mode=='retained-lock':groups.append(mode);continue
            terminal={'event':'stop-completed','reason':'parent Stop','state':0,'closureConfirmed':True,'started':True,'faulted':False,'errorCode':0,'errorDomain':'','productionContainment':False,**{k:claim[k] for k in ['ownerId','generation','guestId','epoch']},'claimSHA256':hashlib.sha256(raw).hexdigest()}
            if mode=='graceful-provision-stop':terminal['reason']='provisioning complete'
            if mode=='wrong-parent':claim['parent']['pid']+=1;raw=json.dumps(claim).encode();(root/'provision-claim.json').write_bytes(raw);terminal['claimSHA256']=hashlib.sha256(raw).hexdigest()
            terminalBytes=json.dumps(terminal).encode();(root/'provision-terminal.json').write_bytes(terminalBytes)
            st=(root/'disk.img').stat();pin={'passed':True,'detached':True,'diskUnchanged':True,'guestId':claim['guestId'],'provisioningClaimSHA256':hashlib.sha256(raw).hexdigest(),'provisioningTerminalSHA256':hashlib.sha256(terminalBytes).hexdigest(),'disk':dict(dev=str(st.st_dev),ino=str(st.st_ino),size=str(st.st_size),mode=st.st_mode,uid=st.st_uid,nlink=st.st_nlink,mtimeNS=str(st.st_mtime_ns),ctimeNS=str(st.st_ctime_ns))}
            if mode=='malformed-number':pin['disk']['dev']+='\0bad'
            (root/'host-key.json').write_text(json.dumps(pin));(root/'host-key.json').chmod(0o600)
            if mode=='changed-disk':(root/'disk.img').rename(root/'original.img');(root/'disk.img').write_bytes(b'replacement');(root/'disk.img').chmod(0o600)
            if mode=='changed-metadata':(root/'machine-id.bin').write_bytes(b'changed')
            if mode=='missing-pin':(root/'host-key.json').unlink()
            extra=None
            if mode=='wrong-descriptor':extra=os.open('/private/tmp',os.O_RDONLY|os.O_DIRECTORY);descriptor=extra
            else:descriptor=999999 if mode=='closed-descriptor' else fd
            if extra is not None:
                child=subprocess.Popen([binary,str(root),owner,generation,'execute',str(extra)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,pass_fds=(fd,extra))
            else:child=phase('execute',descriptor)
            try:
                if mode=='execute-stop':
                    event=claimed(child);execution=json.loads((root/'boot-claim.json').read_text());assert execution['provisioning'] is False and execution['executionAdmitted'] is True
                    out,err=child.communicate(b'stop\n',timeout=8);assert child.returncode==0 and not err
                else:
                    out,err=child.communicate(b'',timeout=8);assert child.returncode==1 and not (root/'boot-claim.json').exists(),(mode,out,err)
            finally:
                if extra is not None:os.close(extra)
            groups.append(mode)
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=5)
            os.close(fd)

for name in ['provision-claim.json','provision-terminal.json','host-key.json']:
    with tempfile.TemporaryDirectory(prefix='saleh-vm-legacy-',dir='/private/tmp') as temp:
        root=Path(temp);fixture(root);(root/name).write_text('{}');(root/name).chmod(0o600)
        child=launch(root);out,err=child.communicate(b'stop\n',timeout=8)
        assert child.returncode==1 and not (root/'boot-claim.json').exists(),('Legacy bypassed phased root',name,out)
        groups.append('legacy-refuses-'+name)
print(json.dumps(dict(passed=True,groups=groups,actualVMStarted=False,syntheticProvisioningRecords=True)))
