// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import * as ssh from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { setTimeout } from 'timers';
import { spawn } from 'child_process'

export class Connection{
  private shellStream:any = null;
  private sftp_conn:any = null;
  private sshConn:any = null;
  private tmpDir:string ="";
  private remote:boolean = false;
  private term: vscode.Terminal|null = null;
  private writeEmitter: vscode.EventEmitter<string>|null = null;
  private closeEmitter: vscode.EventEmitter<void>|null = null;

  public startConnection(configuration, dataCallback, closeCallback):Promise<void>{
    //always remote on windows otherwise check the connection type.
    this.remote = process.platform==='win32'?true:(configuration.host?true:false)
    return new Promise((resolve,reject)=>{
      if (this.remote){
        this.sshConn = new ssh.Client();
        this.sshConn.on('ready',()=>{
          this.sshConn.shell((err,stream)=>{
            if(err){
              reject(err)
              return;
            }
            this.shellStream = stream;
            stream.on('data',(data)=>{
              let ret = dataCallback(data);
              if(ret){
                resolve()
              }
            })
            stream.on('close',()=>{
              closeCallback();
              this.sshConn.end();
            })
          })
          this.sshConn.sftp(async (err,sftp)=>{
            this.sftp_conn=sftp;
          })
        }).connect(configuration)
      }else{
        try{
          this.shellStream = spawn('script',['-q', '--command=bash -l', '/dev/null'], configuration);
          this.writeEmitter = new vscode.EventEmitter<string>();
          this.closeEmitter = new vscode.EventEmitter<void>();
          const shellProc = this.shellStream;
          const writeEmitter = this.writeEmitter;
          const closeEmitter = this.closeEmitter;
          const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,

            open(): void {
              shellProc.stdout!.on('data',(data: Buffer) => {
                let ret = dataCallback(data);
                writeEmitter.fire(data.toString())
                if(ret){
                  resolve()
                }
              });

              shellProc.stderr!.on('data',(data:Buffer) => {
                console.error("Error from stream:", data.toString())
              });

              shellProc.on('exit', () => {
                closeCallback();
                closeEmitter.fire();
              });
            },

            close(): void {
              shellProc.kill('SIGTERM');
              setTimeout(() => {
                if (shellProc.exitCode === null && shellProc.signalCode === null) {
                  shellProc.kill('SIGKILL');
                }
              }, 1000);
              closeCallback();
            },

            handleInput(data: string): void {
              if(data.startsWith("gdb4hpc")){
                shellProc.stdin!.write(`gdb4hpc --interpreter=mi\n`)
              }else{
                shellProc.stdin!.write(data);
              }
            },
          };
          this.term = vscode.window.createTerminal({
            name: 'GDB4HPC PTY',
            pty: pty
          });
          this.term.hide();
        }catch(err){
          reject(err)
        }
      }
    })
  }

  public async uploadFileSFTP(localPath,remotePath):Promise<boolean>{
    if (remotePath.length<=0) {
      return new Promise((resolve)=>{
        resolve(false);
      })
    }
    return await new Promise(async (resolve,reject)=>{
      let timedOut = false;
      const timeoutId = setTimeout(()=>{
        timedOut=true;
        reject(new Error('fastGet timed out'))
      },120000)
      this.sftp_conn.fastPut(localPath, remotePath,(err)=>{
        if (timedOut) return;
        clearTimeout(timeoutId)
        err? reject(err):resolve(true);
      })
    })
  }

  public async getFileSFTP(file:string):Promise<string>{
    if(file.length==0){
      vscode.window.showErrorMessage("No file")
      return ""
    }
    return await new Promise(async (resolve,reject)=>{
      if (this.tmpDir.length==0) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdb4hpc-vscode-src-'));
      const localPath = path.resolve(this.tmpDir, String(file).replace(/\//g,''));
      this.ensureDirExists(localPath)
      let timedOut = false;
      const timeoutId = setTimeout(()=>{
        timedOut=true;
        reject(new Error('fastGet timed out'))
      },120000)
      this.sftp_conn.fastGet(file, localPath,(err)=>{
        if (timedOut) return;
        clearTimeout(timeoutId)
        err? reject(err):resolve(localPath);
      })
    })
  }
  
  public writeToShell(data){
    if(!this.shellStream) return;
    this.remote?this.shellStream.write(`${data}`):this.shellStream.stdin!.write(data);
  }

  public removeFiles(){
    if(this.tmpDir.length>0) fs.rmSync(this.tmpDir, { force:true, recursive: true });
  }
  
  private ensureDirExists(file_path){
    const dir = path.dirname(file_path);
    if(!fs.existsSync(dir)){
      fs.mkdirSync(dir,{recursive:true});
    }
  }

  public closeConnection(){
    const disposeItem = (item: any,type:string) => {
      if (item) {
        if(type=="end"){
          item.end();
        }else{
          item.dispose();
        }
      }
    }
    
    try {
      this.removeFiles();
      if(this.remote){
        disposeItem(this.sftp_conn, "end");
        disposeItem(this.sshConn, "end");
        disposeItem(this.shellStream, "end");
      }else{
        disposeItem(this.term, "");
        disposeItem(this.writeEmitter, "");
        disposeItem(this.closeEmitter, "");
      }
    } catch (error) {
      console.error("Error closing gdb4hpc streams:", error);
    }
  }
}
