"""One fixed Fetch payload only. Native code supplies trusted parent/resources."""
import argparse,ctypes,fcntl,hashlib,json,os,signal,stat,sys,uuid,zipfile
from pathlib import Path

REV='f14622be6addadd62adade8fe848ad68bc8c8db8a62f74ef29ca74948036ea8f'
MANIFEST='ef429821f36d44e2f4a753ca4ee115493fe3cead9d920511cfa1cc9adc5b34cc'
ARCHIVE='726a7e45b56d5d3497300cdc5effea03ecfcb11e43cba0e6d277cc4d5d4125be'
CONTRACT='fb90c11977fb1dd578178215207d71f1be7754f9ed190798eba09d5b1d643e6a'
PYTHON='/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
DIR=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
FILE=os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC
cancelled=False
published=False
def stop(_signum,_frame):
    global cancelled
    cancelled=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
os.umask(0o077)
def check():
    if cancelled:raise RuntimeError('Fetch installation stopped; inspect retained staging before retrying')
def stable(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def identity(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
def owned(s,directory=False,mode=None):
    assert (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)), 'Fetch path has the wrong type'
    assert s.st_uid==os.getuid() and not s.st_mode&0o022 and (directory or s.st_nlink==1),'Fetch path owner, permissions or link count changed'
    if mode is not None:assert stat.S_IMODE(s.st_mode)==mode,'Fetch path mode changed'
class Chain:
    def __init__(self,path):
        self.path=Path(path)
        assert self.path.is_absolute() and str(self.path)==os.path.normpath(str(self.path)) and self.path.resolve(strict=True)==self.path,'Fetch parent must be canonical'
        self.fds=[];self.rows=[];fd=os.open('/',DIR);self.fds.append(fd);current=Path('/')
        for part in self.path.parts[1:]:
            fd=os.open(part,DIR,dir_fd=fd);self.fds.append(fd);current=current/part;s=os.fstat(fd)
            assert stat.S_ISDIR(s.st_mode) and s.st_uid in (0,os.getuid()) and not s.st_mode&0o022,'Fetch ancestor is not trusted'
            self.rows.append((current,fd,identity(s)))
        self.fd=fd;owned(os.fstat(fd),True)
    def verify(self):
        check()
        for path,fd,row in self.rows:assert identity(os.fstat(fd))==identity(os.lstat(path))==row,'Fetch ancestor identity changed'
        if hasattr(self,'lock'):
            fd,row=self.lock
            assert stable(os.fstat(fd))==stable(os.stat('.fetch-plugin.lock',dir_fd=self.fd,follow_symlinks=False))==row,'Fetch writer lock changed'
    def append(self,name,create=False):
        assert name and '/' not in name and name not in ('.','..')
        if create:
            try:os.mkdir(name,0o700,dir_fd=self.fd);os.fsync(self.fd)
            except FileExistsError:pass
        fd=os.open(name,DIR,dir_fd=self.fd);owned(os.fstat(fd),True)
        self.fd=fd;self.fds.append(fd);self.path/=name;self.rows.append((self.path,fd,identity(os.fstat(fd))));self.verify()
    def close(self):
        for fd in reversed(self.fds):os.close(fd)
def read_at(fd,name,limit,mode=None):
    before=os.stat(name,dir_fd=fd,follow_symlinks=False);owned(before,mode=mode)
    assert 0<before.st_size<=limit,'Fetch record exceeds its bound'
    child=os.open(name,FILE,dir_fd=fd)
    try:
        assert stable(before)==stable(os.fstat(child)),'Fetch record changed before read'
        chunks=[];size=0
        while True:
            check();block=os.read(child,min(65536,limit+1-size))
            if not block:break
            size+=len(block);assert size<=limit;chunks.append(block)
        assert stable(before)==stable(os.fstat(child))==stable(os.stat(name,dir_fd=fd,follow_symlinks=False)),'Fetch record changed during read'
        return b''.join(chunks)
    finally:os.close(child)
def hash_file(fd,name,expected):
    before=os.stat(name,dir_fd=fd,follow_symlinks=False);owned(before,mode=expected['mode'])
    assert before.st_size==expected['bytes'],'Fetch file size changed'
    child=os.open(name,FILE,dir_fd=fd)
    try:
        assert stable(before)==stable(os.fstat(child));h=hashlib.sha256()
        while True:
            check();block=os.read(child,65536)
            if not block:break
            h.update(block)
        assert h.hexdigest()==expected['sha256'],'Fetch content hash changed'
        assert stable(before)==stable(os.fstat(child))==stable(os.stat(name,dir_fd=fd,follow_symlinks=False)),'Fetch file changed during read'
    finally:os.close(child)
def load_resources(resources):
    chain=Chain(resources)
    try:
        raw=read_at(chain.fd,'fetch-runtime-v20261024-manifest.json',1024*1024)
        assert hashlib.sha256(raw).hexdigest()==MANIFEST,'Bundled Fetch manifest changed'
        contract=read_at(chain.fd,'fetch-python-v20261024-contract.json',8192)
        assert hashlib.sha256(contract).hexdigest()==CONTRACT,'Bundled Fetch Python contract changed'
        contract=json.loads(contract)
        for key in ['executable','framework']:
            item=contract[key];p=Path(item['absolutePath']);assert p.resolve(strict=True)==p,'Qualified Python canonical path changed'
            # Existing Homebrew is a trusted external dependency, not a newly
            # created private app directory. Cellar may be admin-group writable.
            fd=os.open(p.parent,DIR)
            try:hash_file(fd,p.name,item);assert p.resolve(strict=True)==p
            finally:os.close(fd)
        assert sys.version_info[:3]==(3,14,8),'Fetch requires the qualified existing Python 3.14.8'
        chain.verify();return json.loads(raw)['entries'],chain
    except BaseException:chain.close();raise
def state(parent):
    try:
        before=os.stat('fetch-plugin-v1.json',dir_fd=parent.fd,follow_symlinks=False)
        raw=read_at(parent.fd,'fetch-plugin-v1.json',8192,0o600)
        assert stable(before)==stable(os.stat('fetch-plugin-v1.json',dir_fd=parent.fd,follow_symlinks=False)),'Fetch state identity changed'
    except FileNotFoundError:return None,None
    v=json.loads(raw)
    assert set(v)=={'version','id','revision','manifestSHA256','enabled'} and type(v['version']) is int and v['version']==1 and v['id']=='managed-fetch' and v['revision']==REV and v['manifestSHA256']==MANIFEST and type(v['enabled']) is bool,'Fetch state is not the exact supported revision'
    return v,stable(before)
def verify_tree(chain,entries,sync=False):
    held=[];observed=set()
    def walk(fd,relative):
        row=entries[relative];s=os.fstat(fd);owned(s,True,row['mode']);observed.add(relative)
        names=sorted(os.listdir(fd));expected=sorted(Path(p).name for p in entries if str(Path(p).parent)==relative)
        assert names==expected,'Fetch installed namespace changed'
        for name in names:
            check();rel=relative+'/'+name;e=entries[rel];before=os.stat(name,dir_fd=fd,follow_symlinks=False);observed.add(rel)
            if e['type']=='directory':
                child=os.open(name,DIR,dir_fd=fd);held.append(child);assert identity(before)==identity(os.fstat(child));walk(child,rel);assert identity(before)==identity(os.stat(name,dir_fd=fd,follow_symlinks=False))
            elif e['type']=='file':hash_file(fd,name,e)
            else:
                assert rel.startswith('runtime/bin/') and stat.S_ISLNK(before.st_mode) and before.st_uid==os.getuid() and stat.S_IMODE(before.st_mode)==e['mode'] and os.readlink(name,dir_fd=fd)==e['target'],'Fetch Python alias changed'
                path=chain.path/Path(rel).relative_to('runtime');assert str(path.resolve(strict=True))==PYTHON==e['resolvedPath'],'Fetch Python resolution changed'
                assert stable(before)==stable(os.stat(name,dir_fd=fd,follow_symlinks=False))
        assert names==sorted(os.listdir(fd)) and identity(s)==identity(os.fstat(fd)),'Fetch directory changed during verification'
    try:
        walk(chain.fd,'runtime');assert observed==set(entries);chain.verify()
        if sync:
            for fd in held+[chain.fd]:check();os.fsync(fd)
    finally:
        for fd in held:os.close(fd)
def runtime_chain(parent):
    c=Chain(parent.path)
    try:
        for n in ['extensions','fetch',REV,'runtime']:c.append(n)
        return c
    except BaseException:c.close();raise
def require_no_unpublished(parent):
    c=Chain(parent.path)
    try:
        try:
            for name in ['extensions','fetch']:c.append(name)
        except FileNotFoundError:return
        names=os.listdir(c.fd);c.verify()
        assert not any(name==REV or name.startswith('.install-') for name in names),'An interrupted Fetch publication is retained; inspect it before retrying'
    finally:c.close()
def publish_state(parent,enabled,previous):
    global published
    assert state(parent)==previous,'Fetch state changed before publication; existing state retained'
    parent.verify();v=dict(version=1,id='managed-fetch',revision=REV,manifestSHA256=MANIFEST,enabled=enabled)
    name='.fetch-state-'+str(uuid.uuid4());fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent.fd)
    try:
        data=(json.dumps(v,sort_keys=True)+'\n').encode();offset=0
        while offset<len(data):check();offset+=os.write(fd,data[offset:])
        os.fsync(fd)
    finally:os.close(fd)
    parent.verify();assert state(parent)==previous,'Fetch state changed during preparation; existing state retained'
    os.replace(name,'fetch-plugin-v1.json',src_dir_fd=parent.fd,dst_dir_fd=parent.fd);published=True;os.fsync(parent.fd);parent.verify()
def install(parent,resources,entries):
    global published
    c=Chain(parent.path)
    try:
        for n in ['extensions','fetch']:c.append(n,True)
        try:os.stat(REV,dir_fd=c.fd,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise RuntimeError('Unpublished Fetch runtime exists; retain it and inspect before retrying')
        stage='.install-'+str(uuid.uuid4());os.mkdir(stage,0o700,dir_fd=c.fd);stagefd=os.open(stage,DIR,dir_fd=c.fd)
        archive='fetch-runtime-v20261024.zip'
        hash_file(resources.fd,archive,dict(mode=stat.S_IMODE(os.stat(archive,dir_fd=resources.fd,follow_symlinks=False).st_mode),bytes=18711785,sha256=ARCHIVE))
        archivefd=os.open(archive,FILE,dir_fd=resources.fd)
        try:
            owned(os.fstat(archivefd));assert os.fstat(archivefd).st_size==18711785,'Fetch archive changed before extraction'
            with os.fdopen(archivefd,'rb') as file,zipfile.ZipFile(file) as z:
                infos=z.infolist();assert len(infos)==len(entries) and len({i.filename.rstrip('/') for i in infos})==len(entries)
                for info in infos:
                    check();rel=info.filename.rstrip('/');assert rel in entries and info.filename==rel+('/' if entries[rel]['type']=='directory' else ''),'Fetch archive path changed'
                    e=entries[rel];kind={'file':stat.S_IFREG,'directory':stat.S_IFDIR,'symlink':stat.S_IFLNK}[e['type']]
                    assert info.external_attr>>16==kind|e['mode'],'Fetch archive mode/type changed'
                    assert info.file_size==(e['bytes'] if e['type']=='file' else len(e['target'].encode()) if e['type']=='symlink' else 0),'Fetch archive member size changed'
                    parts=rel.split('/');assert parts[0]=='runtime' and all(n and n not in ('.','..') for n in parts)
                    fd=os.dup(stagefd)
                    try:
                        for name in parts[:-1]:new=os.open(name,DIR,dir_fd=fd);os.close(fd);fd=new
                        name=parts[-1]
                        if e['type']=='directory':
                            os.mkdir(name,e['mode'],dir_fd=fd);made=os.open(name,DIR,dir_fd=fd)
                            try:os.fchmod(made,e['mode'])
                            finally:os.close(made)
                        elif e['type']=='symlink':
                            assert z.read(info).decode()==e['target'];os.symlink(e['target'],name,dir_fd=fd);os.chmod(name,e['mode'],dir_fd=fd,follow_symlinks=False)
                        else:
                            out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,e['mode'],dir_fd=fd)
                            try:
                                os.fchmod(out,e['mode'])
                                h=hashlib.sha256();size=0
                                with z.open(info) as src:
                                    while block:=src.read(65536):
                                        check();h.update(block);size+=len(block);assert size<=e['bytes'],'Fetch archive member exceeds its bound';offset=0
                                        while offset<len(block):check();offset+=os.write(out,block[offset:])
                                assert size==e['bytes'] and h.hexdigest()==e['sha256'];os.fsync(out)
                            finally:os.close(out)
                    finally:os.close(fd)
            staged=Chain(c.path/stage/'runtime')
            try:verify_tree(staged,entries,sync=True)
            finally:staged.close()
            os.fsync(stagefd);parent.verify();c.verify();resources.verify();check()
            rename=ctypes.CDLL(None,use_errno=True).renameatx_np
            rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
            rename.restype=ctypes.c_int
            assert rename(c.fd,stage.encode(),c.fd,REV.encode(),4)==0,'Fetch publication target changed; retained staging was not substituted'
            published=True;os.fsync(c.fd)
        finally:os.close(stagefd)
        for n in ['home','tmp']:
            home=Chain(c.path)
            try:home.append(n,True);home.verify()
            finally:home.close()
        resources.verify();publish_state(parent,False,(None,None))
    finally:c.close()
def main():
    p=argparse.ArgumentParser();p.add_argument('--parent',required=True);p.add_argument('--resources',required=True);p.add_argument('--action',choices=['catalog','install','set_enabled'],required=True);p.add_argument('--enabled',choices=['true','false']);args=p.parse_args()
    assert (args.action=='set_enabled')==(args.enabled is not None),'Fetch enable requires one exact Boolean'
    parent=Chain(args.parent);resources=None;lock=None
    try:
        entries,resources=load_resources(args.resources);previous=state(parent);v=previous[0];new=False
        if args.action!='catalog':
            lock=os.open('.fetch-plugin.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent.fd);owned(os.fstat(lock),mode=0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);parent.lock=(lock,stable(os.fstat(lock)));parent.verify();previous=state(parent);v=previous[0]
        if not v:require_no_unpublished(parent)
        if v:
            c=runtime_chain(parent)
            try:verify_tree(c,entries)
            finally:c.close()
        if args.action=='install' and not v:install(parent,resources,entries);v=state(parent)[0];new=True
        elif args.action=='set_enabled':
            assert v,'Install the exact Fetch runtime before enabling it';publish_state(parent,args.enabled=='true',previous);v=state(parent)[0]
        parent.verify();resources.verify()
        return dict(id='managed-fetch',version='2026.10.24',license='MIT',revision=REV,installed=v is not None,enabled=bool(v and v['enabled']),available=True,newInstall=new,needsConnect=True,connected=False,message='Connect explicitly to review the Fetch catalog. Existing Python 3.14.8 remains required.')
    finally:
        if lock is not None:os.close(lock)
        if resources:resources.close()
        parent.close()
if __name__=='__main__':
    try:print(json.dumps(main(),separators=(',',':')))
    except BaseException as error:
        detail=str(error)[:1600] or type(error).__name__
        if published:detail+=' Publication may have completed; inspect the Fetch catalog/state before any retry.'
        print(json.dumps(dict(isError=True,message=detail,publicationMayHaveCompleted=published),separators=(',',':')));sys.exit(1)
