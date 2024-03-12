// Copyright 2024 Hewlett Packard Enterprise Development LP.

export class Record {
  private readonly recStr: string = '';
  private readonly token: number;
  private readonly type?: string = '';
  private readonly reason?: string;  
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
    this.info.set(result[0], result[1]);
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
    // captures token, type of message, and message reason or full stream message
    let regex = /(\d*)?(\*|~|\^|@)((?:(?<=\*)[_a-zA-Z0-9\-]*)|(?:(?<=\^)done|running|connected|error|exit?)|(?:(?<=\~|@)\".*?\s*\"$))/;
    if ((match = regex.exec(this.buffer))) {
      let token = match[1]!=''?parseInt(match[1]):NaN;
      if (match[2]=='~'||match[2]=='@'){
        //Stream message - remove the opening and closing quotes and any newlines
        let recStr = match[3].substring(1,match[3].length-1);
        recStr = recStr.replace(/^\\n+|\\n+$/g, '').trim();
        return new Record(token, match[2], "", recStr);
      }else if (match[2]=='^'||match[2]=='*'){
        const record = new Record(token,match[2], match[3], this.buffer)
        this.buffer = this.buffer.split(match[0])[1];
        while (this.buffer[0] === ',') {
          this.buffer = this.buffer.substring(1);
          const result = this.parseVariable();
          result?record.addInfo(result):null;
        }
        return record;
      }
    }else if(this.buffer.startsWith("mi: ")){
      return new Record(NaN, "mi", "", this.buffer.split("mi: ")[1]);
    }
    return null;
  }

  private parseVariable(): any[] | null {
    let match: any[] | null;
    //match variable name
    if ((match = /^\s*([a-zA-Z_][a-zA-Z0-9_\-]*)\=/.exec(this.buffer))) {
      this.buffer = this.buffer.substring(match[0].length);
      //get variable value
      let val = this.parseValue();
      return [match[1], val];
    } 
    return null;
  }

  private parseValue(): any {
    let result: any[] | null;

    const skipChars = ((len: number)=>{
      this.buffer = this.buffer.substring(len);
    })

    switch (this.buffer[0]) {
      case '"':
        //value is string
        if ((result = /^\"((\\.|[^"])*)\"/.exec(this.buffer))) {
          //move buffer
          skipChars(result[0].length);
          //return string without quotes
          return result[1];
        } else {
          throw new Error('could not parse: ' + this.buffer);
        }

      case '{':
        //value should be made up of sequence of variables
        const tuple = <any>{};

        while (this.buffer[0] === '{' || this.buffer[0] === ',') {
          skipChars(1);
          //get each variable and its value
          const result = this.parseVariable();
          result ? tuple[result[0]] = result[1] : null;
        }

        skipChars(1);
        return tuple;

      case '[':
        const list: any = [];

        // skip [
        skipChars(1);

        if (['"', '[', '{'].indexOf(this.buffer[0]) !== -1) {
        // could be a list of values, a list of lists, or a list of tuples
          while ((result = this.parseValue())) {
            skipChars(1);
            list.push(result);
          }
        } else {
        //otherwise it is a list of variables
          while ((result = this.parseVariable())) {
            skipChars(1);
            list.push(result);
          }
        }

        skipChars(1);
        return list;

      default:
        return null;
    }
  }
}
