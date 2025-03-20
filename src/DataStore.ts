// Copyright 2025 Hewlett Packard Enterprise Development LP.

import { DebugProtocol } from '@vscode/debugprotocol';
import { getLocalFile} from './Connection';

export class DataStore {
  private variables = new Map<string,any>();
  private threads = new Map<string,any>();
  private stacks = new Map<string,any>();
  private status = new Map<string,any>();
  private threadCount:Map<string,number> = new Map<string,number>();

  public setStatus(name:string,val:any,app?:string,group?:string){
    if(!app){
      this.status.set(name,val)
      return;
    }

    let status:any = this.status.get(name)
    if(!status){
      status=new Map<string,any>()
      this.status.set(name,status);
    }
    let values = status.get(app);
    if (!group){
      status.set(app,val)
      return;
    }
    if (!values){
      values = new Map<string,any>();
      status.set(app,values)
    }
    this.updateMap(values,group)
    values.set(group,val)
  }

  public getStatus(name:string,app?:string):any{
    if (!app) return this.status.get(name)
    let results:any[] = []
    let appStatus = this.status.get(name).get(app)
    if(!appStatus) return
    if (!(appStatus instanceof Map)) return appStatus
    appStatus.forEach((value,key)=>{
      let new_group=this.filterRange(key,this.status.get("groupFilter").get(app))
      if(new_group){
        results.push(value)
      }
    })
    return results
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
    if(!val) val =new Array<DebugProtocol.Breakpoint>()
    val.push(bkpt)
    this.status.set("breakpoints",val)
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
    let values=this.stacks.get(message.proc_set)
    if(!values){
      values = new Map<string,any>()
      this.stacks.set(message.proc_set,values);
    }
    this.updateMap(values,message.group)
    values.set(message.group,stackResults.slice())
  }

  public getStack(app:string,id:number):DebugProtocol.StackFrame[]{
    let stacks = this.stacks.get(app)
    if(!stacks) return []
    let stackResults: DebugProtocol.StackFrame[] = [];
    let threads = this.threads.get(app)
    function getThreadByValue(map, searchValue) {
      for (let [key, value] of map.entries()) {
        if (value.id === searchValue)
          return key;
      }
    }
    const thread_group = getThreadByValue(threads, id);
    console.log(thread_group);
    stacks.forEach((value,key)=>{
      if(this.filterRange(thread_group,key)!=""){
        const updatedValue = { ...value };
        stackResults.push(updatedValue);
      }
    })
    return stackResults
  }

  //update threads 
  public setThreads(messages:any){
    messages.forEach((message)=>{
      let appThreads = this.threads.get(message.proc_set)
      if(!appThreads){
        appThreads=new Map<string,any>()
        this.threads.set(message.proc_set,appThreads);
        this.threadCount.set(message.proc_set,0)
      }
      let group = message.group.toString().replace(/\{|\}/g, "");
      let threadId:number= this.threadCount.get(message.proc_set)!
      let threads:DebugProtocol.Thread[] = [];

      this.updateMap(appThreads,group)
      message.threads.forEach((thread)=>{
        let name= message.proc_set+"{"+group+"}: "+parseInt(thread.id)
        if(appThreads.has(group)){
          let old_thrd=appThreads.get(group).find((old_thread)=>old_thread.name==name)
          if(old_thrd){
            threads.push(old_thrd)
            return;
          }
        }
        threads.push({id: threadId, name: name})
        this.threadCount.set(message.proc_set,threadId+1)
      })
      if(threads) appThreads.set(group,threads)
    })
  }

  //retrieve threads for application
  public getThreads(app:string):DebugProtocol.Thread[]{
    let threads = this.threads.get(app)
    if (!threads)return[]

    let results:DebugProtocol.Thread[] = [];
    threads.forEach((value,key)=>{//for each variable rank,value pair
    
      let new_group=this.filterRange(key,this.status.get("groupFilter").get(app))
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
      let appVariables = this.variables.get(variable.proc_set)
      if(!appVariables){
        appVariables=new Map<string,any>()
        this.variables.set(variable.proc_set,appVariables);
      }
      let name = variable.hasOwnProperty("evaluateName")?variable.evaluateName:variable.name;
      if(!variable.hasOwnProperty("name")) variable["name"]=variable.evaluateName;
      if(!variable.hasOwnProperty("evaluateName")) variable["evaluateName"]=variable.name;
      if(!variable.hasOwnProperty("variableReference")) variable["variableReference"]=0;

      if(!appVariables.has(name)){
        appVariables.set(name,new Map<string,any>())
      }
      let values = appVariables.get(name)
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
          let new_group=this.filterRange(key,this.status.get("groupFilter").get(app))
          if(new_group){
            const updatedValue = value.name+"{"+key+"}:"+value.value ;
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
      value = value.replace(/\\r|\\n|\\v/g, ' ').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    const v: DebugProtocol.Variable = {name:name,type:type,evaluateName:evaluateName,variablesReference:variableReference,value:value};
    return v;
  }

  //helps return current Source line and file
  public getCurrentSource(app:string):Promise<{line:number,file:string}>{
    let displayRank:number = this.status.has("displayRank")?this.status.get("displayRank").get(app):0
    return new Promise(resolve => {
      let sourceStatus = this.status.get("source")
      if(!sourceStatus) resolve({line:0,file:""})
      let appSource:Map<string,any> = sourceStatus.get(app)
      if(!appSource) resolve({line:0,file:""})
      appSource.forEach((value,key)=>{
        let new_group=this.filterRange(key,this.status.get("groupFilter").get(app))
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
    range=range.replace(/\{|\}/g, "");
    const items = range.split(",")
    items.forEach((item)=>{
      if(item.includes('..')){
        const [start,end]=item.split('..').map(x=>parseInt(x))
        result.push([start,end])
      }else{
        let itm = parseInt(item)
        result.push([itm,itm])
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
    let rem=0;
    let base=0;
    while(rem<removeRangeParts.length&&base<baseRangeParts.length){
      let [remStart,remEnd]=removeRangeParts[rem];
      let [baseStart,baseEnd]=baseRangeParts[base];
      //remove range is less than the base,check next remove range
      if(remEnd<baseStart){
        rem++
        continue;
      }
      //remove range is more than the base,check next base range
      if(remStart>baseEnd){
        resultParts.push([baseStart,baseEnd]);
        base++
        continue;
      }
      //remove range contains the full base, check next base range
      if(remStart<=baseStart&&remEnd>=baseEnd){
        base++;
        continue;
      }

      //base range contains the full remove range
      if(remStart>baseStart&&remEnd<baseEnd){
        resultParts.push([baseStart,Math.min(baseEnd,remStart-1)]);
        resultParts.push([Math.max(baseStart,remEnd+1),baseEnd]);
        rem++
        continue;
      }

      //partial removal(could be both)
      //remove start is more than base start, but less than baseEnd
      if(remStart>baseStart){
        resultParts.push([baseStart,Math.min(baseEnd,remStart-1)]);
      }else{
        rem++
      }
      
      //remove end is less than base end but more than base start
      if(remEnd<baseEnd){
        resultParts.push([Math.max(baseStart,remEnd+1),baseEnd]);
      }else{
        base++
      }
      
    }
    //add remaining base ranges
    while(base<baseRangeParts.length){
      resultParts.push(baseRangeParts[base]);
      base++;
    }
    return this.rangeToString(resultParts);
  }

  //returns if two ranges have overlap ie (1..4,6)   (2..5,7)  = (2..4)
  //mostly used for filtering in vscode by ranks
  private filterRange(range1:string,range2:string):string|undefined{
    let result: [number,number][]=[];
    if (!range1||!range2||range1==""||range2=="") return;
    const range1Parsed=this.parseRange(range1)
    const range2Parsed=this.parseRange(range2)
    let r1=0
    let r2=0
    while(r1<range1Parsed.length&&r2<range2Parsed.length){
      let [start1,end1]=range1Parsed[r1]
      let [start2,end2]=range2Parsed[r2]
      const newStart = Math.max(start1,start2)
      const newEnd = Math.min(end1,end2)
      if(newStart<=newEnd){
        result.push([newStart,newEnd])
      }
      end1<end2?r1++:r2++
    }
    return this.rangeToString(result);
  }

  //update map in preparation for adding new values
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
