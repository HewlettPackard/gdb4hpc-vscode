// Copyright 2024 Hewlett Packard Enterprise Development LP.

export class Record {
  private readonly recStr: string = '';
  private readonly token: number;
  private readonly type: string = '';
  private readonly reason: string;  
  private info: Map<string, any>;

  public constructor(token: number, type: string, reason: string, recStr: string) {
    this.token = token;
    this.type = type;
    this.reason = reason;
    this.recStr = recStr;
    this.info = new Map();
  }

  public getToken() {
    return this.token;
  }

  public getType() {
    return this.type;
  }

  public getReason() {
    return this.reason;
  }

  public addInfo(result: any) {
    this.info.set(Object.keys(result)[0],Object.values(result)[0]);
  }

  public getInfo(key: string): any {
    return this.info.get(key);
  }

  public printRecord(): string {
    return this.recStr;
  }
}

export class MIParser {
  private buffer: string = '';

  public parseRecord(str:string): Record | null {
    let match: any[] | null;
    this.buffer = str;
    // captures (token)(type of message)   (message reason or full stream message)
    let regex = /(\d*)?(\*|~|\^|@)((?:(?<=\*)[\w\-]*)|(?:(?<=\^)done|running|connected|error|exit?)|(?:(?<=\~|@)\".*?\s*\"$))/;
    if(this.buffer.startsWith("mi: ")){
      return new Record(NaN, "mi", "", this.buffer.split("mi: ")[1]);
    }else if ((match = regex.exec(this.buffer))) {
      let token = match[1]!=''?parseInt(match[1]):NaN;
      if (match[2]=='~'||match[2]=='@'){
        //Stream message - remove the opening and closing quotes and any newlines
        let recStr = match[3].substring(1,match[3].length-1);
        recStr = recStr.replace(/^\\n+|\\n+$/g, '').trim();
        return new Record(token, match[2], "", recStr);
      }else if (match[2]=='^'||match[2]=='*'){
        const record = new Record(token,match[2], match[3], this.buffer)
        this.buffer = this.buffer.split(match[0])[1];
        this.buffer = this.buffer.substring(1);
        const results = this.parseVar();
        if (results.length!==0){
          results.forEach((result)=>{
            result?record.addInfo(result):null;
          })
        }
        return record;
      }
    }
    return null;
  }

  private parseVar(ind?:number): any | null {
    let match: any[] | null;
    let results: any[] = [];
    //match                 match[1]                 match[2]                match[3]
    //regex               (variable name) =         ("|{|[|]|})  (if quotes, get string in between)
    let regex =   /(?:(?:\s*([a-zA-Z_][\w\-]*)\=)?("|\[|\{|\}|\])(?:(?<=\=")(.*?)(?=(?<!\\)")")?)/g
    //if index is provided, move the regex to that index
    if(ind){
      regex.lastIndex=ind;
    }
    //while matches can be found
    while(match = regex.exec(this.buffer)){
      let variable: any;
      let val: any;
      // if it is the end of list or object, return all results gotten and last index of regex
      if (match[2]=="\]"|| match[2]=="}"){
        return {res:results, ind:regex.lastIndex};
      }
      //if not a {} or [], push item to results 
      else if (match[2]!="\{"&&match[2]!="\["){
        variable = match[1];
        val = match[3];
      }
      // if { or [, go into getResults to recursively get results of the bracket or curly brace
      else{
        let res = this.getResults(match[2], regex.lastIndex)
        //move regex index to new index so it doesn't repeat what was found recursively
        regex.lastIndex=res.ind 
        // results from getResults should be pushed to final result string
        variable = match[1];
        val = res.results;
      }
      // if variable name provided, results should be pushed as a key-value pair, otherwise push results
      if (variable){
        var obj = {}
        obj[variable]=val
        results.push(obj)
      }else{
        results.push(val)
      }
    }
    return results;
  }

  private getResults(type: string, new_ind: any){
    //parse the inside of { or [ to get the results inside
    let result = this.parseVar(new_ind);
    switch (type){
      //if { put all results in key value pairs
      case "\{":
        const pairs: any = {};
        result.res.forEach((item)=>{
          pairs[Object.keys(item)[0]]=Object.values(item)[0]
        })
        return {results: pairs, ind: result.ind};
      // if [ push all results to an array
      case "\[":
        const list: any = [];
        result.res.forEach((item)=>{
          list.push(item);
        })
        return {results: list, ind: result.ind};
      default:
        return {results:"",ind:new_ind};
    }
  }
}
