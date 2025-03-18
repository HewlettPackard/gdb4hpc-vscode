// Copyright 2025 Hewlett Packard Enterprise Development LP.

import { DebugProtocol } from '@vscode/debugprotocol';
import { getLocalFile} from './Connection';

export class DataStore {
  private variables = new Map<string,any>();
  private threads = new Map<string,any>();
  private stacks = new Map<string,any>();
  private status=new Map<string,any>();
  private threadCount:Map<string,number> = new Map<string,number>();

  public setStatus(name:string,val:any,app?:string,group?:string){
    if(app){
      if(!this.status.get(name)){
        this.status.set(name,new Map<string,any>());
      }
      if(group){
        if(!this.status.get(name).get(app)){
          this.status.get(name).set(app,new Map<string,any>())
        }
        let values = this.status.get(name).get(app)
        this.updateMap(values,group)
        values.set(group,val)
      }
    }else{
      switch(name){
      case "breakpoints":
        if(!this.status.get(name)){
          let breakpoints:DebugProtocol.Breakpoint[]=[];
          this.status.set(name,breakpoints)
        }
        this.status.get(name).push(val)
        break;
      default:
        this.status.set(name,val)
        break;
      }
    }
  }

  public getStatus(name:string,app?:string):any{
    if(app){
      let results:any[] = []
      if(!this.status.get(name).get(app)) return
      this.status.get(name).get(app).forEach((value,key)=>{
        let new_group=this.filterRange(key,this.status.get("groupFilter"))
        if(new_group){
          results.push(value)
        }
      })
      return results
    }
    return this.status.get(name)
  }

  public removeFileBreakpoints(file:string):DebugProtocol.Breakpoint[]{
    if(!this.status.get("breakpoints")) return [];
    let removeBkpts=this.status.get("breakpoints")
    removeBkpts=removeBkpts.filter(bkpt => {
      return bkpt.source?.path == file;
    });
    let filtered = this.status.get("breakpoints")
    filtered=filtered.filter(bkpt => {
      return bkpt.source?.path != file;
    });
    this.status.set("breakpoints",filtered);
    return removeBkpts;
  }

  public addBreakpoint(bkpt:DebugProtocol.Breakpoint){
    let val = this.status.get("breakpoints")
    if(!val){
      this.status.set("breakpoints",new Array<DebugProtocol.Breakpoint>())
    }
    val=this.status.get("breakpoisnts")
    val.push(bkpt)
  }

  //set stack with new stack results
  public setStack(startFrame:number,endFrame:number,message:any){
    let stackResults: DebugProtocol.StackFrame[] = [];
    let stack = message.stack
    for (let i = startFrame; i < Math.min(endFrame, stack.length); i++) {
      let frame = stack[i].frame;
      let file = getLocalFile(frame.fullname)
      stackResults.push({id:i,name:frame.func,source:{name:frame.file,path:file,sourceReference:1},
                line:parseInt(frame.line),column:0, instructionPointerReference:frame.addr});
    }

    if(!this.stacks.has(message.proc_set)) this.stacks.set(message.proc_set,new Map<string,any>());
    let values=this.stacks.get(message.proc_set)
    this.updateMap(values,message.group)
    values.set(message.group,stackResults.slice())
  }

  public getStack(app:string,id:number):DebugProtocol.StackFrame[]{
    let stacks = this.stacks.get(app)
    if(!stacks) return []
    let stackResults: DebugProtocol.StackFrame[] = [];
    stacks.forEach((value,key)=>{
      const updatedValue = { ...value };
      stackResults.push(updatedValue);
    })
    return stackResults
  }

  //update threads 
  public setThreads(messages:any){
    messages.forEach((message)=>{
      if(!this.threads.has(message.proc_set)){
        this.threads.set(message.proc_set,new Map<string,any>());
        this.threadCount.set(message.proc_set,0)
      }
      let group = message.group.toString().replace(/\{|\}/g, "");
      let threadId:number= this.threadCount.get(message.proc_set)!
      let threads:DebugProtocol.Thread[] = [];

      let values=this.threads.get(message.proc_set)
      this.updateMap(values,group)
      message.threads.forEach((thread)=>{
        let name= message.proc_set+"{"+group+"}: "+parseInt(thread.id)
        if(values.has(group)){
          let old_thrd=values.get(group).find((old_thread)=>old_thread.name==name)
          if(old_thrd){
            threads.push(old_thrd)
            return;
          }
        }
        threads.push({id: threadId, name: name})
        this.threadCount.set(message.proc_set,threadId+1)
      })
      if(threads) values.set(group,threads)
    })
  }

  //retrieve threads for application
  public getThreads(app:string):DebugProtocol.Thread[]{
    let threads = this.threads.get(app)
    if (!threads)return[]

    let results:DebugProtocol.Thread[] = [];
    threads.forEach((value,key)=>{//for each variable rank,value pair
      let new_group=this.filterRange(key,this.status.get("groupFilter"))
      if(!new_group||(new_group&&new_group!="")){
        results.push(... value);
      }
    })
    return results;
  }

  //update Variable list
  public updateVars(variables:any):any{
    variables.forEach(variable_old=>{
      let variable ={...variable_old}
      if(!this.variables.get(variable.proc_set)){
        this.variables.set(variable.proc_set,new Map<string,any>());
      }
      let name = variable.hasOwnProperty("evaluateName")?variable.evaluateName:variable.name;
      if(!variable.hasOwnProperty("name")) variable["name"]=variable.evaluateName;
      if(!variable.hasOwnProperty("evaluateName")) variable["evaluateName"]=variable.name;
      if(!variable.hasOwnProperty("variableReference")) variable["variableReference"]=0;

      if(!this.variables.get(variable.proc_set).has(name)){
        this.variables.get(variable.proc_set).set(name,new Map<string,any>())
      }
      let values = this.variables.get(variable.proc_set).get(name)
      let v=this.createVar(variable.name,variable.evaluateName,variable.type,variable.variableReference,variable.value)
      this.updateMap(values,variable.group)
      values.set(variable.group,{...v})      
    });
    return this.variables
  }

  //check if variable exists already
  public varExists(app:string,name:string){
    return this.variables.get(app).has(name);
  }

  //get local variables for display
  public getLocalVariables(app:string):DebugProtocol.Variable[]{
    const variables: DebugProtocol.Variable[] = [];
    let appVars = this.variables.get(app);
    if(appVars){
      appVars.forEach((variable)=>{
        variable.forEach((value,key)=>{
          const updatedValue = { ...value, name: value.name+"{"+key+"}" };
          variables.push(updatedValue);
        })
      })
    }
    return variables;
  }

  //get a value for a variable for evaluateRequest
  public getVariableValue(app:string,name:string):{value:string,variablesReference:number}{
    let variables: string[] = [];
    let found_variable = this.variables.get(app).get(name);
    let varReference=0
    if(found_variable){
      found_variable.forEach((variable)=>{
        variable.forEach((value,key)=>{
          varReference=value.variablesReference
          let new_group=this.filterRange(key,this.status.get("groupFilter"))
          if(new_group){
            const updatedValue = value.name+"{"+new_group+"}:"+value.value ;
            variables.push(updatedValue)
          }
        })
      })
    }
    return {value:variables.join('\n'),variablesReference:varReference};
  }

  //create a variable
  private createVar(name:string, evaluateName:string, type:string, variableReference:number,value:any):DebugProtocol.Variable{
    if (typeof value === 'string' && value) {
      value = value.replace(/\\r/g, ' ').replace(/\\t/g, '\t').replace(/\\v/g, '\v').replace(/\\"/g, '"')
                                .replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, ' ');
    }
    const v: DebugProtocol.Variable = {name:name,type:type,evaluateName:evaluateName,variablesReference:variableReference,value:value};
    return v;
  }

  //helps return current Source line and file
  public getCurrentSource(app:string):Promise<{line:number,file:string}>{
    let displayRank:number = this.status.has("displayRank")?this.status.get("displayRank").get(app):0
    return new Promise(resolve => {
      if(!this.status.has("source")) resolve({line:0,file:""})
      if(!this.status.get("source").has(app)) resolve({line:0,file:""})
      let source:Map<string,any> = this.status.get("source").get(app)
      
      if(!displayRank) displayRank=0
      source.forEach((value,key)=>{
        let new_group=this.filterRange(key,this.status.get("groupFilter"))
        if(!new_group||(new_group&&new_group!="")){
          resolve(value)
        }
      })
      resolve({line:0,file:""})
    })
  }

  //converts a range value to string
  private rangeToString(range:[number,number][]):string{
    let result:string[]=[]
    range.forEach(([start,end])=>{
      if(start==end){
        result.push(start.toString())
      }else{
        result.push(`${start}..${end}`)
      }
    })
    return result.join(",");
  }

  public parseRange(range:string):[number,number][]{
    let result:[number,number][]=[]
    range=range.toString().replace(/\{|\}/g, "");
    const items = range.split(",")
    items.forEach((item)=>{
      if(item.includes('..')){
        const [start,end]=item.split('..').map(x=>parseInt(x))
        result.push([start,end])
      }else{
        result.push([parseInt(item),parseInt(item)])
      }
    })
    return result;
  }

  //if values for different ranks are updating, 
  // remove the ranks that are being updated
  //and keep the value for the old ranks that didn't change
  //i.e. if ranks 1..4 = "a" and then rank 2 gets updated to "b"
  //rank 2 gets removed from 1..4 to create
  // ranks 1,3..4="a" and rank 2="b"
  private removeRange(removeRanges:string,baseRanges:string){
    let resultParts:[number,number][]=[]
    const removeRangeParts = this.parseRange(removeRanges)
    const baseRangeParts = this.parseRange(baseRanges)
    baseRangeParts.forEach(([baseStart,baseEnd])=>{
      removeRangeParts.forEach(([remStart,remEnd]) =>{
        if(remEnd<baseStart||remStart>baseEnd){
          resultParts.push([baseStart,baseEnd]);
          return;
        }
        if(remStart>baseStart) resultParts.push([baseStart,Math.min(baseEnd,remStart-1)]);
        if(remEnd<baseEnd) resultParts.push([Math.max(baseStart,remEnd+1),baseEnd]);
      })
    })
    return this.rangeToString(resultParts);
  }

  //returns if two ranges have overlap ie (1..4,6)   (2..5,7)  = (2..4)
  //mostly used for filtering in vscode by ranks
  private filterRange(range1:string,range2:string):string|undefined{
    let result: [number,number][]=[];
    if (range1==""||range2=="") return;
    const range1Parsed=this.parseRange(range1)
    const range2Parsed=this.parseRange(range2)
    range1Parsed.forEach(([start1,end1])=>{
      range2Parsed.forEach(([start2,end2])=>{
        const newStart = Math.max(start1,start2);
        const newEnd = Math.min(end1,end2);
        if(newStart<=newEnd){
          result.push([newStart,newEnd])
        }
      })
    })
    return this.rangeToString(result);
  }

  //update map in preperation for adding new values
  private updateMap(map:any,group:string){
    group=group.toString().replace(/\{|\}/g, "");
    let results:{remaining:string,value:string}[]=[]
    map.forEach((val:any,key:string)=>{
      if(group==key){
        return;
      }
      const remaining = this.removeRange(group,key)
      if(remaining!=key){
        results.push({remaining:remaining,value:val})
        map.delete(key)
      }
    })
    //add new key/value for new remaining range
    results.forEach(({remaining,value})=>{
      map.set(remaining,value)
    })
  }
}
