// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import {clearInterval} from 'timers';
import {ILaunchRequestArguments} from './DebugSession';
import {Breakpoint, Source, StackFrame} from '@vscode/debugadapter';
import {DebugProtocol} from '@vscode/debugprotocol';
import {Record, MIParser} from './MIParser';
import { compare_list } from './CompareProvider';
import {writeToShell, startConnection, getRemoteFile, displayFile} from './Connection'
import { readFileSync } from 'fs';

export var pe_list: Procset[] = [];

export interface DbgVar {
  name: string;  //name of variable
  referenceName: string;  //name assigned by MI
  childNum: number;   //number of children
  referenceID: number;  //scope tracking id
  type: string;   //variable type
  values: any[];
}

export interface DbgThread{
  procset: string;
  group: number[];
  id: number;
  name: string;
}

export interface DbgBkpt{
  num: number;
  bkpt: Breakpoint;
  file: string;
  line: string;
}

export interface Procset {
	name: string;
	procset: string;
  isSelected: boolean;
}

export class GDB4HPC extends EventEmitter {
  private cwd: string;
  public apps: any;
  private environmentVariables: string[];
  private setupCommands: string[];
  private output_panel: vscode.OutputChannel;
  private mi_log: vscode.OutputChannel;
  private error_log: vscode.OutputChannel;
  private appRunning = true;
  private cmdPending: any[] = [];
  private data ='';
  private parser: MIParser = new MIParser();
  private token = 1;
  private breakpoints: DbgBkpt[]=[];
  private threads: Map<string,DbgThread[]> = new Map<string,DbgThread[]>();
  private stacks: Map<string,any[]> = new Map<string,any[]>();
  private variables: DbgVar[]=[];
  private focused:{name:string,procset:any}={name:"",procset:{}};
  private appendedVars: string[];
  private started: boolean;
  private launchCount:number =0;
  private remote:boolean = true;
  private connConfig = {};
  private runningCommands: { [key: string]: Promise<any>|null } = {
    '-thread-info':null,
    '-stack-list-frames':null,
    '-decomposition-list':null,
    '-procset-list':null,
    '-var-update --all-values *':null,
    '-stack-list-variables':null
  }

  //spawn gdb4hpc
  public spawn(args: ILaunchRequestArguments): Promise<boolean>  {
    this.started = false;
    this.cwd = args.cwd || '';
    this.environmentVariables = args.env || [];
    this.remote = args.connConfig.host?true:false
    this.connConfig = args.connConfig.host?{
      host: args.connConfig.host,
      port: args.connConfig.port,
      username: args.connConfig.username,
      privateKey: readFileSync(args.connConfig.privateKey)
    }:{
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: this.cwd,
      env: Object.assign(this.environmentVariables, process.env, this.appendedVars)
    }
    console.warn(this.connConfig)
    this.appendedVars=[];
    this.focused.name = "";
    this.focused.procset = {};
    let regex = /\$(\w+)\:([\s\S]*)/;
    let match: any[]|null;
    for (const key in args.env) {
      if ((match = regex.exec(args.env[key]))) {
        this.appendedVars[key]=match[2]+":"+process.env[match[1]];
      }
    }
    this.apps = args.apps;
    this.setupCommands = args.setupCommands
    this.output_panel = vscode.window.createOutputChannel("Program Output")
    this.mi_log = vscode.window.createOutputChannel("MI Log");
    this.error_log = vscode.window.createOutputChannel("Error Log");
    return new Promise(resolve => {
      this.createStream().then(()=>{
        resolve(true)
      })
    })
  }

  //launch applications
  public launchApp(num:number):  Promise<boolean> {
    let app = this.apps[num];
    return new Promise(resolve => {
      this.sendCommand(`launch $`+ app.procset + ` ` + app.program + ` ` + app.args).then(()=>{
        this.setFocus("all","")
        this.launchCount ++;
        this.appRunning= true;
        Promise.all(this.cmdPending).then(() => {
          resolve(true); 
        });
      })
    });
  }

  //create shell stream to connect gdb4hpc to vscode
  private createStream(): Promise<boolean> {

    //callback for handling data
    let onData = (data) =>{
      //remove color codes
      data = data.toString()
      data = data.replaceAll("\x1b[0m","");
      data = data.replaceAll("\x1b[30;1m","");
      data = data.replace("dbg all> ","");

      //check to see gdb4hpc is running, if so launch program
      if (!this.isStarted()){
        if(data.includes("(gdb)")){
          this.started = true;
          return true;
        }
      }
      this.handleOutput(data);
    }

    //callback to close gdb4hpc connection
    let onClose = () =>{
      this.output_panel.dispose();
      this.mi_log.dispose();
    }

    //setup local/remote connection
    return new Promise(resolve => {
      startConnection(this.remote,this.connConfig,onData,onClose).then(()=>{
        resolve(true)
      })

      //if setupCommands are provided, use them to launch gdb4hpc
      if (this.setupCommands.length>0){
        this.setupCommands.forEach(item => {
          writeToShell(`${item}\n`)
        });
        writeToShell(`gdb4hpc --interpreter=mi\n`);
      }else{
        vscode.window.showInformationMessage("Please add setupCommands or launch gdb4hpc in the Debug Console")
      }
    });
  }

  //intercept commands before sending to gdb4hpc in case of duplicates
  public sendCommand(command:string): Promise<any> { 
    //if not in list send command and return promise as normal
    if(!(command in this.runningCommands)){
      return this.send(command);
    }

    //if in list and not null, it's already started so return the running promise
    if(this.runningCommands[command]){
      return this.runningCommands[command];
    }

    //otherwise send the command to gdb4hpc
    this.runningCommands[command] = this.send(command).finally(()=>{
      this.runningCommands[command] = null;
    })

    //return for the call that started the command run
    return this.runningCommands[command];
  }

  //send command to shell and get the parsed output back
  private send(command: string): Promise<any> {
    return new Promise(resolve => {
      if (!this.isStarted()){
        if (command.startsWith("gdb4hpc")){
          //start gdb4hpc with the interpreter set to mi
          writeToShell(`${command} --interpreter=mi\n`);
        }else{
          writeToShell(`${command}\n`);
        }
      }
      else if (!command.startsWith("-")) {
        writeToShell(`${command}\n`);
        resolve(true);
      }
      else {
        writeToShell(`${this.token + command}\n`);
        //once token is found the parsed record is sent back to the function that called the command
        this.cmdPending.push({token: this.token, res: ((record: Record) => {
          resolve(record);
        })})
        this.token++;
      }
    });
  }

  private handleOutput(data: any): void {
    let lines: string[] = []

    const getLines = (i: number)=>{
      if(i < 0) return;
      lines = this.data.slice(0, i).split('\n');
      this.data = this.data.slice(i + 1);
    }
    this.data+=data;
    if (!this.data) return;
    
    getLines(this.data.lastIndexOf('\n'));

    lines.forEach(line => {
      line = line.trim();

      //if gdb4hpc is not started, show all output in Debug Console
      if (!this.isStarted()){
        this.emit('output', line, 'console');
        return;
      }
      let record = this.parser.parseRecord(line);
      if(record){
        switch (record.type) {
          case '*':
            this.handleAsyncRecord(record);
            break;

          case '~':
            this.emit('output', record.recStr, 'console');
            break;

          case 'mi':
              this.mi_log.appendLine(record.recStr);
              break;
          
          case '@':
            this.output_panel.appendLine(record.recStr);
            this.output_panel.show(); //always display output panel if output was added
            break;
          
          case '^':
            if (!isNaN(record.token)) {
              const promise = this.cmdPending.find((element) => element.token == record!.token);
              promise?.res(record);
              const index = this.cmdPending.indexOf(promise);
              (index > -1)?this.cmdPending.splice(index, 1):null;
              
            }else{
              if(record.reason=="error"){
                vscode.window.showErrorMessage(record.info?.get('msg'));
                this.error_log.appendLine(record.info?.get('msg'));
                this.error_log.show();
              }
            }
            break;
          default:
            break;
        } 
      }else{
        if(line.toLowerCase().includes("error")){
          this.error_log.appendLine(line);
        }
      }
    });
  }

  private handleAsyncRecord(record: Record) {
    switch (record.reason) {
      case 'stopped':
          this.appRunning = false;
          let reason = record.info?.get('reason');
          let procset = record.info?.get('proc_set');
          let group = record.info?.get('group');
          switch (reason) {
            case 'breakpoint-hit':
            case 'end-stepping-range':
              const fullName=record.info?.get('frame')["fullname"];
              const line = parseInt(record.info?.get('frame')["line"]);
              let i = this.apps.findIndex(app=>app.name==procset);
              if(i>=0&&i<this.apps.length){
                this.apps[i].line=line;
                this.apps[i].file=fullName;
              }

              //open file and line if it's in the active debug session
              if(vscode.debug.activeDebugSession?.name==procset){
                displayFile(line,fullName);
              }
              break;

            case 'exited-normally':
              this.sendCommand('-gdb-exit');
              break;

            default:
              console.error('Unknown stop reason');
          }
          this.emitEvent(reason,procset,group);
        break;

      case 'running':
        this.appRunning = true;
        break;
    }
  }

  private emitEvent(event: string, procset: string, group: string){
    if(event=='exited-normally'){
      this.emit('exited-normally')
    }else if(event=='breakpoint-hit'|| event=='end-stepping-range'){
      let threads = this.getSessionThreads(procset);
      if (threads.length>0){
        threads.forEach ((thread, index)=>{
            this.emit(event,index,procset,group);
        });
      }else{
        let groupArr = this.getGroupArray(group);
        for (let i =1; i<=groupArr.length; i++){
          this.emit(event,i);
        }
      }
    }
  }

  public continue(): Promise<any> {
    return this.sendCommand('-exec-continue');
  }

  public stepIn(): Promise<any> {
    return this.sendCommand(`-exec-step`);
  }

  public stepOut(): Promise<any> {
    return this.sendCommand(`-exec-finish`);
  }

  public next(): Promise<any> {
    return this.sendCommand(`-exec-next`);
  }

  public pause(): Promise<any> {
    return this.sendCommand(`-exec-interrupt`);
  }

  public terminate(): Promise<any> {
    return this.sendCommand('-gdb-exit');
  }

  public getThreads(): Promise<Map<string, DbgThread[]>> { 
    return new Promise(resolve => {
      this.sendCommand('-thread-info').then((record: Record) => {
        let results:Map<string, DbgThread[]> = new Map<string,DbgThread[]>(); 
        
        //create a list of threads in focus
        record.info?.get('msgs').forEach((message:any)=>{
          message['threads'].forEach((thread) => {
            let new_thread = {procset: message['proc_set'], group: this.getGroupArray(message['group']), 
              id: results.has(message['proc_set'])?results.get(message['proc_set'])!.length:0, 
              thread_id: parseInt(thread.id), name: message['proc_set']+message['group']+": "+parseInt(thread.id)};
            if(results.has(message['proc_set'])){
              results.get(message['proc_set'])!.push(new_thread)
            }else{
              results.set(message['proc_set'],[new_thread])
            }
          });
        })
        if (this.threads.size === 0){
          results.forEach((value, key) => {
            this.threads.set(key, value);
          });
        }else{
          //keep threads if not in focus, otherwise replace with the result threads
          for (const key of results.keys()) {
            if(!this.threads.has(key)){
              this.threads.set(key,results.get(key)!);
            }else{
              let arr:DbgThread[] = this.threads.get(key)!.filter((thread)=>results.get(key)!.every((result)=>!result.group.some((el)=>thread.group.includes(el))));
              arr=[...arr,...<[]>results.get(key)]
              this.threads.set(key,arr);
            }
          };
        }
        resolve(this.threads);
      });
    });
  }

  public getVariable(name: string): DbgVar | undefined {
    let variable = this.findVariable(name);
    if (!variable){
      this.createVariable(name).then((v) => {
        return v;
      });
    }else{
      return variable;
    }
  }

  private findVariable(name: string): DbgVar | undefined {
    return this.variables.find((variable) => variable.name === name || variable.referenceName === name);
  }

  //mi variable sends value in format of $a{i}: val\n$b{j}: val\n...etc. 
  //parse out the procset, group, and value for each procset in the value
  public parseVariableRecord(str: string): any[]{
    if (!str) return [{}];
    let split_variables = /\\n(?=\w+\{?[\S]*\}?\:)/;
    let variables_str = str.split(split_variables);
    let result: any[] = [];
    variables_str.forEach(variable=>{
      let regex = /(\w+)\{([\S]*)\}\:([\s\S]*)/;
      let match: any[]|null;
      if ((match = regex.exec(variable))) {
        result.push({'procset':match[1],'group':match[2], 'value':match[3]})
      }
    })
    return(result)
  }

  //send var-create command to gdb4hpc and retreive output
  private createVariable(name: string): Promise<DbgVar> {
    return new Promise(resolve => {
      this.sendCommand(`-var-create - * "${name}"`).then((recordVariable) => {
        let variables_match = this.parseVariableRecord(recordVariable.info!.get('value'));
        const numchild = parseInt(recordVariable.info!.get('numchild')) || parseInt(recordVariable.info!.get('has_more')) || 0;
        //create an array of values from mi message          
        
        let vals:any[]=[];
        variables_match.forEach(variable=>{
          vals.push({'procset':variable['procset'],'group':variable['group'],'value':variable['value']})
        });

        //create a new variable with all of the variations of values in one variable
        const newVariable: DbgVar = {
          name: name,
          referenceName: recordVariable.info!.get('name'),
          childNum: numchild,
          referenceID: numchild ? this.variables.length + 1 : 0, 
          type: recordVariable.info!.get('type'),
          values: vals
        };

        this.variables.push(newVariable);
        resolve(newVariable);
      });
    });
  }
  
  // send var-update command to gdb4hpc and get answer
  private updateVariables(): Promise<DbgVar[]> {
    return new Promise(resolve => {
      this.sendCommand(`-var-update --all-values *`).then((record:Record)=> {
        record.info?.get('changelist').forEach(variableRecord => {

          //get saved variable and update it
          let variable = this.findVariable(variableRecord.name);
          if (!variable) return resolve(this.variables)
          let variables_match = this.parseVariableRecord(variableRecord.value);
          variables_match.forEach(variable_match =>{
            //find saved variable corresponding to variable being updated from mi message
            let found = variable!.values.find(obj => {
              return obj.procset === variable_match['procset'] && obj.group === variable_match['group']
            });
            //if variable has a value stored for matching procset and group, update the value
            //otherwise add it
            if (found){
              found.value = variable_match['value']
            }else{
              variable!.values.push({'procset':variable_match['procset'],'group':variable_match['group'],'value':variable_match['value']})
            }
          })
        });
        resolve(this.variables);
      });
    });
  }
  
  //get list of variables from gdb4hpc
  public getVariables(): Promise<DbgVar[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-variables`).then((record: Record) => {
        record.info?.get('msgs').forEach(message => {
          const pending: Promise<DbgVar>[] = [];
          message['variables'].forEach(variable => {
            if (!this.findVariable(variable.name)){
              pending.push(this.createVariable(variable.name));
            }
          });
          Promise.all(pending).then(() => {
            this.updateVariables()
          });
        });
        resolve(this.variables); 
      });
    });
  }

  public stack(startFrame: number, endFrame: number, id:number, session:string): Promise<DebugProtocol.StackFrame[]> {
    let threads=this.getSessionThreads(session);
    let requestThread:DbgThread[] = threads.filter((thread)=>thread.id == id);
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-frames`).then((record: Record) => {
        let final:DebugProtocol.StackFrame[] = [];
        record.info?.get('msgs').forEach((message:any)=>{
          let stackResults: DebugProtocol.StackFrame[] = [];
          let msg_procset = message['proc_set'];
          let msg_group = message['group'];
          let stack = message['stack']
          for (let i = startFrame; i < Math.min(endFrame, stack.length); i++) {
            let frame = stack[i].frame;
            const sf: DebugProtocol.StackFrame = new StackFrame(i,frame.func,new Source(frame.file,frame.fullname,1),parseInt(frame.line));
            sf.instructionPointerReference = frame.addr;
            stackResults.push(sf);
          }
          
          //update existing items in this.stacks with new stack info
          if (this.stacks.has(msg_procset)){
            this.stacks.get(msg_procset)?.forEach((old:any)=>{
              if (this.getGroupArray(msg_group).includes(old.rank)){
                old.stack=stackResults.slice();
              }
            })
          }else{
            //add new items to this.stacks
            let ranks = this.getGroupArray(msg_group)
            let appStacks:any = []
            ranks.forEach((rank)=>{
              appStacks.push({"rank":rank,"stack":stackResults.slice()})
            })
            this.stacks.set(msg_procset,appStacks)
          }
        })

        //return only the stacks for requested thread
        final = this.stacks.get(requestThread[0].procset)?.filter((rankItem)=>requestThread[0].group.includes(rankItem.rank))[0].stack
        resolve(final);
      })
    });
	}

  public setBreakpoints(file: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<Breakpoint[]> {
    const pending: Promise<boolean>[] = [];
    
    //SetBreakpointRequest clears all breakpoints
    const clearBkpts = (file: string): Promise<boolean>=>{
      return new Promise(resolve => {
        const fileBkpts = this.breakpoints.filter(bkpt => {
          return bkpt.file == file;
        });
        fileBkpts.forEach((bkpt) => {
          this.sendCommand(`-break-delete ${bkpt.num}`);
        });
        this.breakpoints = this.breakpoints.filter(bkpt => {
          return bkpt.file != file;
        });
        resolve(true); 
      });
    }

    //Send Command to insert new breakpoint
    const insertBkpt = (file: string, line: number): Promise<any> =>{
      // XXX: setting breakpoint pending every time is a hack we have to do until CPE-6345 is implemented
      return this.sendCommand("-gdb-set breakpoint pending on")
        .then(() => this.sendCommand(`-break-insert ${file}:${line}`))
        .then((breakpoint: Record) => {
          const bkpt = breakpoint.info!.get('bkpt');
          if (!bkpt) return;
          this.breakpoints.push({num:parseInt(bkpt.number), bkpt:new Breakpoint(true, bkpt.line,undefined, new Source(file,file)),file:file,line:bkpt.line})
      });
    }

    return new Promise(resolve => {
      file=this.remote?getRemoteFile(file):file
      //gdb4hpc needs to be connected and ready before breakpoints can be set
      if (this.appRunning){
        const intv = setInterval(() => {
          if (!this.appRunning) {
            clearInterval(intv);
            this.setBreakpoints(file, breakpoints).then(bps =>resolve(bps));
          }
        }, 100);
      }else{
        clearBkpts(file).then(() => {
          breakpoints.forEach(srcBkpt => pending.push(insertBkpt(file, srcBkpt.line)));
          Promise.all(pending).then(() => {
            const fileBkpts = this.breakpoints.filter(bkpt => {
              return bkpt.file == file;
            });
            resolve(fileBkpts.map(a => a.bkpt));
          });
        });
      }
    });
  }

  public addProcset(name: string, procset: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-define $${name} $${procset}`);
      if (name)this.setFocus(name,procset)
      resolve(true)
    })
	}

  public getProcsetList(): Promise<Procset[]> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-list`).then((record: Record) => {
        pe_list = [];
        record.info?.get('pe_sets').forEach(set =>{
          let selected = (set.name == this.focused.name)?true:false;
          pe_list.push({name:set['name'], procset:set['proc_set'],isSelected:selected})
        })
        resolve(pe_list);
      })  
    });
	}

  public changeFocus(input: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-focus $${input}`).then((record: Record) => {
        let name = record.info?.get('focus')['name'];
        let procsets = record.info?.get('focus')['proc_set']
        if(name)this.setFocus(name,procsets);
        resolve(true);
      })
    });
	}

  private setFocus(name:string,procsets:string){
    this.focused.name = name
    this.focused.procset={};
    if(name =="all"){
      //get all procsets to put in focus
      let merged:any = []
      for(let i =0; i<this.launchCount;i++){
        merged.push(this.apps[i].procset);
      }
      procsets=merged.toString();
    }
    let items = procsets.split(/\,/)
    items.forEach(item=>{
      let split = item.split(/\{|\}/)
      this.focused.procset[split[0]]=this.getGroupArray(split[1])
    })
  }

  //turn group string into an array
  private getGroupArray(group:string):number[]{
    let g: number[] =[];
    if(!group){
      return [];
    }
    group = group.replace(/\{|\}/g, '')
    group.split(',').forEach((item)=>{
      if (item.includes("..")){
        const [min,max]=item.split("..");
        for (var i = parseInt(min); i <= parseInt(max); i++) {
          g.push(i);
       }
      }else{
        g.push(parseInt(item))
      }
    })
    return g;
  }

  public buildDecomposition(new_decomp: any): Promise<any> {
    return new Promise(resolve => {
      if (new_decomp.length == 0){
        resolve(false);
      }
      
      let cmds = new_decomp.join("\n");
      this.sendCommand(cmds);
      this.sendCommand(`-decomposition-list`).then((record: Record)=>{
        let decomps = record.info?.get("decompositions");
        resolve(decomps);
      });      
    });
  }

  public runComparisons(): Promise<any> {
    const runComparison = (comparison: any): Promise<boolean> => {
      return new Promise(resolve => {
        this.sendCommand(`-compare ${comparison.text}`).then((record: Record) => {
          if(record.reason =="error"){
            vscode.window.showErrorMessage(record.info?.get('msg'));
          }else{
            comparison.result = record.info?.get("compare")["result"];
            comparison.result=comparison.result.replace(/\\n/g, "\n");
          }
          resolve(true)
        })
      });
    }

    return new Promise(resolve => {
      let pending: Promise<boolean>[] = [];
      compare_list.forEach( (comparison)=>{
        if (comparison.checked){
          pending.push(runComparison(comparison))
        }else{
          comparison.result ="";
        }
      })
      Promise.all(pending).then(() => {
        resolve(compare_list);
      });
    });
	}

  public buildAssertionScript(new_script: any): Promise<boolean> {
    return new Promise(resolve => {
      let cmds:string[] =[];
      cmds.push(`build $${new_script.name}`);
      cmds.push(`set stop ${new_script.stopOnError}`);
      //verbose breakpoints will cause gdb4hpc to emit breakpoint events as they happen, updating display
      cmds.push(`set verbose-breakpoints on`);

      new_script.asserts.forEach(assert =>{
        cmds.push(`assert ${assert.str}`);
      })
      cmds.push(`end`);
      this.sendCommand(cmds.join("\n")).then(() => {
        resolve(true);
      });
      
    });
  }

  public runAssertionScript(assertion: any): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`start $${assertion.name}`).then(() => {
        resolve(true);
      })
    });
  }

  public getAssertionResults(script: any): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-script-list $${script.name} results`).then((record: Record) => {
        let assert_results = record.info?.get("script_result")["assertions"];
        assert_results.forEach((assert, i)=>{
          let updated = script.asserts[i]
          updated["pass"] = assert.pass;
          updated["warn"] = assert.warn;
          updated["fail"] = assert.fail;
        })
        resolve(true);
      })
    });
  }

  public isStarted(): boolean {
    return this.started;
  }

  //filter application threads
  public getSessionThreads(session:string): DbgThread[]{
    if(this.threads.has(session)){
      return this.threads.get(session)!
    }else{
      let empty: DbgThread[] = [];
      return empty;
    }
  }

  public getFocused(): any{
    return this.focused;
  }

  
  public getCurrentLine(app:number):number{
    if(this.apps[app].line){
      return this.apps[app].line
    }else{
      return 0
    }
  }

  public getCurrentFile(app:number):string{
    if(this.apps[app].file){
      return this.apps[app].file
    }else{
      return ""
    }
  }
}
