// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import {clearInterval} from 'timers';
import { readFileSync } from 'fs';
import {DebugProtocol} from '@vscode/debugprotocol';
import {Record, MIParser} from './MIParser';
import { compare_list } from './CompareProvider';
import {writeToShell, startConnection, getRemoteFile, displayFile} from './Connection'
import {ILaunchRequestArguments} from './DebugSession';
import { DataStore } from './DataStore';

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
  private cmdPending: any[] = [];
  private data ='';
  private parser: MIParser = new MIParser();
  private token = 1;
  private appendedVars: string[];
  private launchCount:number =0;
  private connConfig = {};
  private runningCommands: { [key: string]: Promise<any>|null } = {
    '-thread-info':null,
    '-stack-list-frames':null,
    '-decomposition-list':null,
    '-procset-list':null,
    '-var-update --all-values *':null,
    '-stack-list-variables':null
  }
  private dataStore:DataStore=new DataStore();

  //spawn gdb4hpc
  public spawn(args: ILaunchRequestArguments): Promise<boolean>  {
    this.dataStore.setStatus("started",false);
    this.cwd = args.cwd || '';
    this.environmentVariables = args.env || [];
    this.dataStore.setStatus("remote",args.connConfig.host?true:false);
    this.dataStore.setStatus("appRunning",false);
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

    this.appendedVars=[];
    this.dataStore.setStatus("focused",{name:"",procset:""});
    let regex = /\$(\w+)\:([\s\S]*)/;
    let match: any[]|null;
    for (const key in args.env) {
      if ((match = regex.exec(args.env[key]))) {
        this.appendedVars[key]=match[2]+":"+process.env[match[1]];
      }
    }
    this.apps = args.apps;
    this.apps.forEach((app)=>{
      let procsets=app.procset.split(/\{|\}/)[1]
      let group = "0.."+procsets[1]
      this.dataStore.setStatus("source", {line:0,file:""}, procsets[0], group)
      this.dataStore.setStatus("appData", {program: app.program, args: app.args}, procsets[0], group)
    })
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
      console.warn("in launch app")
      this.sendCommand(`launch $`+ app.procset + ` ` + app.program + ` ` + app.args).then(()=>{
        console.warn("launched")
        let appData = this.dataStore.getStatus("appData")
        let merged:any=[];
        for(const key in appData.keys()){
          let proc=key+"{"+appData.get(key).keys()[0]+"}"
          console.warn("procset:",proc)
          merged.push(proc)
        }
        this.dataStore.setStatus("focused",{name:"all",procset:merged.join(",")});
        this.dataStore.setStatus("appRunning",true)
        let split =app.procset.split(/\{|\}/)
        this.dataStore.setStatus("groupFilter",split[1],split[0],split[1])
        this.dataStore.setStatus("rankDisplay",0)  
        this.launchCount ++;
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
      if (!this.dataStore.getStatus("started")){
        if(data.includes("(gdb)")){
          this.dataStore.setStatus("started",true);
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
      startConnection(this.dataStore.getStatus("remote"),this.connConfig,onData,onClose).then(()=>{
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
      if (!this.dataStore.getStatus("started")){
        console.warn("send command:",command)
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
      console.warn("line:",line)

      //if gdb4hpc is not started, show all output in Debug Console
      if (!this.dataStore.getStatus("started")){
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
          this.dataStore.setStatus("appRunning",false);
          let reason = record.info?.get('reason');
          let procset = record.info?.get('proc_set');
          let group = record.info?.get('group');
          switch (reason) {
            case 'breakpoint-hit':
            case 'end-stepping-range':
              console.warn("stopped:",record)
              this.dataStore.setStatus("source",{line:parseInt(record.info?.get('frame')["line"]),file:record.info?.get('frame')["fullname"]},
                  procset,group);
              console.warn("stored data")
              //open file and line if it's in the active debug session
              if(vscode.debug.activeDebugSession?.name==procset){
                console.warn("is activeSession current")
                let {line,file} = this.dataStore.getCurrentSource(procset);
                console.warn("display",line,file)
                if(file!="") displayFile(line,file);
                console.warn("displayFile done")
              }
              console.warn("out of active session current")
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
        this.dataStore.setStatus("appRunning",true);
        break;
    }
  }

  private emitEvent(event: string, procset: string, group:string){
    if(event=='exited-normally'){
      this.emit('exited-normally')
    }else if(event=='breakpoint-hit'|| event=='end-stepping-range'){
      let threads = [...this.dataStore.getThreads(procset).values()];
      console.warn("emitEvent threads:",[...threads])
      if (threads.length>0){
        threads.forEach ((thread, index)=>{
          console.warn("emmiting for thread:",index)
            this.emit(event,index);
        });
      }else{
        let parsedGroup=this.dataStore.parseRange(group);
        parsedGroup.forEach(([start,end])=>{
          for (let i:number = start; i<=end;i++){
            this.emit(event,i);
          }
        })
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

  public getThreads(app:string): Promise<DebugProtocol.Thread[]> { 
    return new Promise(resolve => {
      this.sendCommand('-thread-info').then((record: Record) => {
        let results:DebugProtocol.Thread[]=[]
        record.info?.get('msgs').forEach((message:any)=>{
          results.push(...this.dataStore.setThreads(app,message))
        })
        console.warn([...results])
        resolve(results);      
      });
    });
  }

  public evaluateVariable(app:string, name: string): Promise<DebugProtocol.Variable[]> {
    return new Promise(resolve => {
      if (!this.dataStore.varExists(app,name)){
        this.createVariable(name).then(() => {
          let result = this.dataStore.getLocalVariables(app).filter(variable=>variable.evaluateName===name)
          resolve(result);
        });
      }
      this.updateVariables().then(() => {
        //let result = variables.filter((variable)=>variable.name === name)
        let result = this.dataStore.getLocalVariables(app).filter(variable=>variable.evaluateName===name)
        resolve(result);
      });
    })
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
  private createVariable(name: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-var-create - * "${name}"`).then((recordVariable) => {
        let variables_match = this.parseVariableRecord(recordVariable.info!.get('value'));
        const numchild = parseInt(recordVariable.info!.get('numchild')) || parseInt(recordVariable.info!.get('has_more')) || 0;
        //create an array of values from mi message          
        //type va1={proc_set:string; group:string; name:string;evaluateName:string;type:string;variableReference:number;value:string}
        let vars:any[] = [];
        variables_match.forEach(variable=>{
          let v = {proc_set:variable.proc_set,group:variable.group,name:name,evaluateName:recordVariable.info!.get('name'),
            type:recordVariable.info!.get('type'),variableReference:numchild,value:variable.value
          }
          vars.push(v)
        });
        this.dataStore.updateVars(vars)
        resolve(true);
      });
    });
  }
  
  // send var-update command to gdb4hpc and get answer
  private updateVariables(): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-var-update --all-values *`).then((record:Record)=> {
        //type va1={proc_set:string; group:string; name:string;evaluateName:string;type:string;variableReference:number;value:string}
        let vars:any[] = [];
        record.info?.get('changelist').forEach(variableRecord => {
          //get the new values for possibly different procsets and groups
          let variables_match = this.parseVariableRecord(variableRecord.value);
          variables_match.forEach(variable_match =>{
            //find saved variable corresponding to variable being updated from mi message
            let v = {proc_set:variable_match.proc_set,group:variable_match.group,
              evaluateName:variableRecord.name, value:variable_match.value}
            vars.push(v)
          })
        });
        this.dataStore.updateVars(vars)
        resolve(true);
      });
    });
  }

  //get list of variables from gdb4hpc
  public getVariables(app:string): Promise<DebugProtocol.Variable[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-variables`).then((record: Record) => {
        this.dataStore.updateVars(record.info?.get('variables'))
        resolve(this.dataStore.getLocalVariables(app));
      });
    });
  }

  public stack(startFrame: number, endFrame: number, id:number, session:string): Promise<DebugProtocol.StackFrame[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-frames`).then((record: Record) => {
        let final:DebugProtocol.StackFrame[] = [];
        record.info?.get('msgs').forEach((message:any)=>{
          this.dataStore.setStack(startFrame,endFrame,message)
          final=[...final,...this.dataStore.getStack(message.proc_set,id)]
        })
        console.warn("stack returned",[...final])
        resolve(final);
      })
    });
	}

  public setBreakpoints(file: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    const pending: Promise<boolean>[] = [];
    
    //SetBreakpointRequest clears all breakpoints
    const clearBkpts = (file: string): Promise<boolean>=>{
      return new Promise(resolve => {
        const fileBkpts = this.dataStore.removeFileBreakpoints(file)
        fileBkpts.forEach((bkpt) => {
          this.sendCommand(`-break-delete ${bkpt.id}`);
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
          this.dataStore.addBreakpoint({verified:true, line:bkpt.line,source:{path:file},id:parseInt(bkpt.number)})
      });
    }

    return new Promise(resolve => {
      file=this.dataStore.getStatus("remote")?getRemoteFile(file):file
      //gdb4hpc needs to be connected and ready before breakpoints can be set
      if (this.dataStore.getStatus("appRunning")==true){
        const intv = setInterval(() => {
          if (!this.dataStore.getStatus("appRunning")) {
            clearInterval(intv);
            this.setBreakpoints(file, breakpoints).then(bps =>resolve(bps));
          }
        }, 100);
      }else{
        clearBkpts(file).then(() => {
          breakpoints.forEach(srcBkpt => pending.push(insertBkpt(file, srcBkpt.line)));
          Promise.all(pending).then(() => {
            let a = this.dataStore.getStatus("breakpoints")
            if(a){
              const fileBkpts = a.filter(bkpt => {
                return bkpt.source?.path == file;
              });
              resolve(fileBkpts);
            }
            resolve([])
          });
        });
      }
    });
  }

  public addProcset(name: string, procset: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-define $${name} $${procset}`);
      if (name) this.dataStore.setStatus("focused",{name:name,procset:procset})
      resolve(true)
    })
	}

  public getProcsetList(): Promise<Procset[]> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-list`).then((record: Record) => {
        let pe_list:{name:string,procset:string,isSelected:boolean}[]= [];
        record.info?.get('pe_sets').forEach(set =>{
          let selected = (set.name == this.dataStore.getStatus("focused").name)?true:false;
          pe_list.push({name:set['name'], procset:set['proc_set'],isSelected:selected})
        })
        this.dataStore.setStatus("pe",pe_list)
        resolve(pe_list);
      })  
    });
	}

  public changeFocus(input: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-focus $${input}`).then((record: Record) => {
        let name = record.info?.get('focus').name;
        let procsets = record.info?.get('focus').procset
        if(name) this.dataStore.setStatus("focused",{name:name,procset:procsets})
        resolve(true);
      })
    });
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
  
  public getCurrentSource(app:string):{line:number,file:string}{
    return this.dataStore.getCurrentSource(app)
  }

  public setGroupFilter(value:string){
    this.dataStore.setStatus("groupFilter",value);
  }
  public setDisplayRank(num:number){
    this.dataStore.setStatus("rankDisplay",num);
  }
}
