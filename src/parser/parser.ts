//-----------------------------------------------------------
// Parser
//-----------------------------------------------------------

import * as commonmark from "commonmark";
import * as chev from "chevrotain";
import {parserErrors, EveError} from "./errors";
var {Lexer, tokenMatcher} = chev;
export var Token = chev.Token;
import {v4 as uuid} from "uuid";

//-----------------------------------------------------------
// Utils
//-----------------------------------------------------------

function cleanString(str:string) {
  let cleaned = str
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, "\"")
    .replace(/\\{/g, "{")
    .replace(/\\}/g, "}");
  return cleaned;
}

function toEnd(node:any) {
  if(node && node.tokenType !== undefined) {
    return node.endOffset! + 1;
  }
  return node.endOffset;
}

//-----------------------------------------------------------
// Markdown
//-----------------------------------------------------------

let markdownParser = new commonmark.Parser();

function parseMarkdown(markdown: string, docId: string) {
  let parsed = markdownParser.parse(markdown);
  let walker = parsed.walker();
  var cur;
  let tokenId = 0;
  var text = [];
  var extraInfo:any = {};
  var pos = 0;
  var lastLine = 1;
  var spans = [];
  var context = [];
  var blocks = [];
  while(cur = walker.next()) {
    let node = cur.node as any;
    if(cur.entering) {
      while(node.sourcepos && node.sourcepos[0][0] > lastLine) {
        lastLine++;
        pos++;
        text.push("\n");
      }
      if(node.type !== "text") {
        context.push({node, start: pos});
      }
      if(node.type == "text" || node.type === "code_block" || node.type == "code") {
        text.push(node.literal);
        pos += node.literal.length;
      }
      if(node.type == "softbreak") {
        text.push("\n");
        pos += 1;
        lastLine++;
        context.pop();
      }
      if(node.type == "code_block") {
        let spanId = `${docId}|block|${tokenId++}`;
        let start = context.pop()!.start;
        node.id = spanId;
        node.startOffset = start;
        let type = node.type;
        if(!(node as any)._isFenced) {
          type = "indented_code_block";
        } else {
          blocks.push(node);
        }
        spans.push(start, pos, node.type, spanId);
        lastLine = node.sourcepos[1][0] + 1;
      }
      if(node.type == "code") {
        let spanId = `${docId}|${tokenId++}`;
        let start = context.pop()!.start;
        spans.push(start, pos, node.type, spanId);
      }
    } else {
      let info = context.pop()!;
      if(node !== info.node) {
        throw new Error("Common mark is exiting a node that doesn't agree with the context stack");
      }
      if(node.type == "emph" || node.type == "strong" || node.type == "link") {
        let spanId = `${docId}|${tokenId++}`;
        spans.push(info.start, pos, node.type, spanId);
        if(node.type === "link") {
          extraInfo[spanId] = {destination: node._destination};
        }
      } else if(node.type == "heading" || node.type == "item") {
        let spanId = `${docId}|${tokenId++}`;
        spans.push(info.start, info.start, node.type, spanId);
        extraInfo[spanId] = {level: node._level, listData: node._listData};
      }
    }
  }
  return {text: text.join(""), spans, blocks, extraInfo};
}

//-----------------------------------------------------------
// Tokens
//-----------------------------------------------------------

const breakChars = "@#\\.,\\(\\)\\[\\]\\{\\}⦑⦒:\\\"";

// Markdown
export class DocContent extends Token { static PATTERN = /[^\n]+/; }
export class Fence extends Token {
  static PATTERN = /```|~~~/;
  static PUSH_MODE = "code";
}
export class CloseFence extends Token {
  static PATTERN = /```|~~~/;
  static POP_MODE = true;
}

// Comments
export class CommentLine extends Token { static PATTERN = /\/\/.*\n/; label = "comment"; static GROUP = "comments"; }

// Operators
export class Equality extends Token { static PATTERN = /:|=/; label = "equality"; }
export class Comparison extends Token { static PATTERN = />=|<=|!=|>|</; label = "comparison"; }
export class AddInfix extends Token { static PATTERN = /\+|-/; label = "infix"; }
export class MultInfix extends Token { static PATTERN = /\*|\//; label = "infix"; }
export class Merge extends Token { static PATTERN = /<-/; label = "merge"; }
export class Set extends Token { static PATTERN = /:=/; label = "set"; }
export class Mutate extends Token { static PATTERN = /\+=|-=/; label = "mutate"; }
export class Dot extends Token { static PATTERN = /\./; label = "dot"; }
export class Pipe extends Token { static PATTERN = /\|/; label = "pipe"; }

// Identifier
export class Identifier extends Token { static PATTERN = new RegExp(`([\\+-/\\*][^\\s${breakChars}]+|[^\\d${breakChars}\\+-/\\*][^\\s${breakChars}]*)(?=[^\\[])`); label = "identifier"; }
export class FunctionIdentifier extends Token { static PATTERN = new RegExp(`([\\+-/\\*][^\\s${breakChars}]+|[^\\d${breakChars}\\+-/\\*][^\\s${breakChars}]*)(?=\\[)`); label = "functionIdentifier"; }

// Keywords
export class Keyword extends Token {
    static PATTERN = Lexer.NA;
    static LONGER_ALT = Identifier;
}
export class Lookup extends Keyword { static PATTERN = /lookup(?=\[)/; label = "lookup"; }
export class Action extends Keyword { static PATTERN = /bind|commit/; label = "action"; }
export class Search extends Keyword { static PATTERN = /search/; label = "search"; }
export class If extends Keyword { static PATTERN = /if/; label = "if"; }
export class Else extends Keyword { static PATTERN = /else/; label = "else"; }
export class Then extends Keyword { static PATTERN = /then/; label = "then"; }
export class Not extends Keyword { static PATTERN = /not/; label = "not"; }

// Values
export class Bool extends Keyword { static PATTERN = /true|false/; label = "bool"; }
export class Num extends Token { static PATTERN = /-?\d+(\.\d+)?/; label = "num"; }
export class None extends Keyword { static PATTERN = /none/; label = "none"; }
export class Name extends Token { static PATTERN = /@/; label = "name"; }
export class Tag extends Token { static PATTERN = /#/; label = "tag"; }

// Delimiters
export class OpenBracket extends Token { static PATTERN = /\[/; label = "open-bracket"; }
export class CloseBracket extends Token { static PATTERN = /\]/; label = "close-bracket"; }
export class OpenParen extends Token { static PATTERN = /\(/; label = "open-paren"; }
export class CloseParen extends Token { static PATTERN = /\)/; label = "close-paren"; }

// Strings
export class StringChars extends Token { static PATTERN = /(\\.|{(?=[^{])|[^"\\{])+/; label = "string"; }
export class OpenString extends Token {
  static PATTERN = /"/;
  static PUSH_MODE = "string";
  label = "quote";
}
export class CloseString extends Token {
  static PATTERN = /"/;
  static POP_MODE = true;
  label = "quote";
}

// String Embeds
export class StringEmbedOpen extends Token {
  static PATTERN = /{{/;
  static PUSH_MODE = "code";
  label = "string-embed-open";
}
export class StringEmbedClose extends Token {
  static PATTERN = /}}/;
  static POP_MODE = true;
  label = "string-embed-close";
}

// Whitespace
export class WhiteSpace extends Token {
  static PATTERN = /\s+|,/;
  static GROUP = Lexer.SKIPPED;
}

//-----------------------------------------------------------
// Lexers
//-----------------------------------------------------------

let codeTokens: any[] = [
  CloseFence, WhiteSpace, CommentLine, OpenBracket, CloseBracket, OpenParen,
  CloseParen, StringEmbedClose, OpenString, Bool, Action, Set, Equality, Dot, Pipe, Merge,
  Mutate, Comparison, Num,  Search, Lookup, If, Else, Then,
  Not, None, Name, Tag, FunctionIdentifier, Identifier, AddInfix, MultInfix
];

let stringEmbedTokens: any[] = [StringEmbedClose].concat(codeTokens);

let LexerModes:any = {
  "doc": [WhiteSpace, Fence, DocContent],
  "code": codeTokens,
  "string": [CloseString, StringEmbedOpen, StringChars],
  // "stringEmbed": stringEmbedTokens,
};

let allTokens: any[] = codeTokens.concat([Fence, DocContent, CloseString, StringEmbedOpen, StringEmbedClose, StringChars]);

let EveDocLexer = new Lexer({modes: LexerModes, defaultMode: "doc"});
let EveBlockLexer = new Lexer({modes: LexerModes, defaultMode: "code"});

//-----------------------------------------------------------
// Parse Nodes
//-----------------------------------------------------------

export type NodeDependent = chev.IToken | ParseNode;

export interface ParseNode {
  type?: string
  id?: string
  startOffset?: number,
  endOffset?: number,
  from: NodeDependent[]
  [property: string]: any
}

export class ParseBlock {
  id: string;
  start: number;
  nodeId = 0;
  variables: {[name: string]: ParseNode} = {};
  equalities: any[] = [];
  scanLike: ParseNode[] = [];
  expressions: ParseNode[] = [];
  binds: ParseNode[] = [];
  commits: ParseNode[] = [];
  variableLookup: {[name: string]: ParseNode};
  links: string[] = [];
  tokens: chev.Token[];
  searchScopes: string[] = [];
  parent: ParseBlock | undefined;

  constructor(id:string, variableLookup?:any) {
    this.id = id;
    this.variableLookup = variableLookup || {};
  }

  toVariable(name:string, generated = false) {
    let variable = this.variableLookup[name];
    if(!variable) {
      this.variableLookup[name] = this.makeNode("variable", {name, from: [], generated});
    }
    variable = this.variables[name] = this.variableLookup[name];
    return {id: variable.id, type: "variable", name, from: [], generated};
  }

  addUsage(variable:any, usage:any) {
    let global = this.variableLookup[variable.name];
    global.from.push(usage)
    if(global.from.length === 1) {
      global.startOffset = usage.startOffset;
      global.endOffset = toEnd(usage);
    }
    variable.from.push(usage);
    variable.startOffset = usage.startOffset;
    variable.endOffset = toEnd(usage);
    this.links.push(variable.id, usage.id);
  }

  equality(a:any, b:any) {
    this.equalities.push([a, b]);
  }

  commit(node: ParseNode) {
    this.commits.push(node);
  }

  bind(node: ParseNode) {
    this.binds.push(node);
  }

  expression(node: ParseNode) {
    this.expressions.push(node);
  }

  scan(node: ParseNode) {
    this.scanLike.push(node);
  }

  makeNode(type:any, node: ParseNode) {
    if(!node.id) {
      node.id = `${this.id}|node|${this.nodeId++}`;
    }
    for(let from of node.from as any[]) {
      this.links.push(node.id, from.id);
    }
    if(node.from.length) {
      node.startOffset = node.from[0].startOffset;
      node.endOffset = toEnd(node.from[node.from.length - 1]);
    }
    node.type = type;
    return node;
  }

  addSearchScopes(scopes: string[]) {
    for(let scope of scopes) {
      if(this.searchScopes.indexOf(scope) === -1) {
        this.searchScopes.push(scope);
      }
    }
  }

  subBlock() {
    let neue = new ParseBlock(`${this.id}|sub${this.nodeId++}`, this.variableLookup);
    neue.parent = this;
    return neue;
  }
}


//-----------------------------------------------------------
// Parser
//-----------------------------------------------------------

export class Parser extends chev.Parser {
  customErrors: any[];
  block: ParseBlock;
  activeScopes: string[];
  currentAction: string;

  // Parser patterns
  doc: any;
  codeBlock: any;
  fencedBlock: any;
  section: any;
  searchSection: any;
  actionSection: any;
  value: any;
  bool: any;
  num: any;
  scopeDeclaration: any;
  name: any;
  statement: any;
  expression: any;
  attribute: any;
  attributeEquality: any;
  attributeComparison: any;
  attributeNot: any;
  attributeOperation: any;
  record: any;
  tag: any;
  functionRecord: any;
  notStatement: any;
  comparison: any;
  infix: any;
  attributeAccess: any;
  actionStatement: any;
  actionEqualityRecord: any;
  actionAttributeExpression: any;
  actionOperation: any;
  actionLookup: any;
  variable: any;
  recordOperation: any;
  ifExpression: any;
  ifBranch: any;
  elseIfBranch: any;
  elseBranch: any;
  multiplication: any;
  addition: any;
  infixValue: any;
  parenthesis: any;
  attributeMutator: any;
  singularAttribute: any;
  stringInterpolation: any;


  constructor(input:any) {
    super(input, allTokens, {});
    let self = this;
    let asValue = (node:any) => {
      if(node.type === "constant" || node.type === "variable" || node.type === "parenthesis") {
        return node;
      } else if(node.variable) {
        return node.variable;
      }
      throw new Error("Tried to get value of a node that is neither a constant nor a variable.\n\n" + JSON.stringify(node));
    }
    let ifOutputs = (expression:any) => {
      let outputs = [];
      if(expression.type === "parenthesis") {
        for(let item of expression.items) {
          outputs.push(asValue(item));
        }
      } else {
        outputs.push(asValue(expression));
      }
      return outputs;
    }

    let makeNode = (type:string, node:any) => {
      return self.block.makeNode(type, node);
    }

    let blockStack:any[] = [];
    let pushBlock = (blockId?:string) => {
      let block;
      let prev = blockStack[blockStack.length - 1];
      if(prev) {
        block = prev.subBlock();
      } else {
        block = new ParseBlock(blockId || "block");
      }
      blockStack.push(block);
      self.block = block;
      return block;
    }

    let popBlock = () => {
      let popped = blockStack.pop();
      self.block = blockStack[blockStack.length - 1];
      return popped;
    }

    //-----------------------------------------------------------
    // Doc rules
    //-----------------------------------------------------------

    self.RULE("doc", () => {
      let doc = {
        full: [] as any[],
        content: [] as any[],
        blocks: [] as any[],
      }
      self.MANY(() => {
        self.OR([
          {ALT: () => {
            let content = self.CONSUME(DocContent);
            doc.full.push(content);
            doc.content.push(content);
          }},
          {ALT: () => {
            let block : any = self.SUBRULE(self.fencedBlock);
            if(doc.content.length) {
              block.name = doc.content[doc.content.length - 1].image;
            } else {
              block.name = "Unnamed block";
            }
            doc.full.push(block);
            doc.blocks.push(block);
          }},
        ])
      });
      return doc;
    });

    self.RULE("fencedBlock", () => {
      self.CONSUME(Fence);
      let block = self.SUBRULE(self.codeBlock);
      let fence = self.CONSUME(CloseFence);
      return block;
    });

    //-----------------------------------------------------------
    // Blocks
    //-----------------------------------------------------------

    self.RULE("codeBlock", (blockId = "block") => {
      blockStack = [];
      let block = pushBlock(blockId);
      self.MANY(() => { self.SUBRULE(self.section) })
      return popBlock();
    })

    self.RULE("section", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.searchSection) }},
        {ALT: () => { return self.SUBRULE(self.actionSection) }},
        {ALT: () => { return self.CONSUME(CommentLine); }},
      ]);
    });


    //-----------------------------------------------------------
    // Scope declaration
    //-----------------------------------------------------------

    self.RULE("scopeDeclaration", () => {
      let scopes:any[] = [];
      self.OR([
        {ALT: () => {
          self.CONSUME(OpenParen);
          self.AT_LEAST_ONE(() => {
            let name: any = self.SUBRULE(self.name);
            scopes.push(name.name);
          })
          self.CONSUME(CloseParen);
        }},
        {ALT: () => {
          self.AT_LEAST_ONE2(() => {
            let name: any = self.SUBRULE2(self.name);
            scopes.push(name.name);
          })
        }},
      ]);
      return scopes;
    });


    //-----------------------------------------------------------
    // Search section
    //-----------------------------------------------------------

    self.RULE("searchSection", () => {
      // @TODO fill in from
      let from:any[] = [];
      self.CONSUME(Search);
      let scopes:any = ["session"];
      self.OPTION(() => { scopes = self.SUBRULE(self.scopeDeclaration) })
      self.activeScopes = scopes;
      self.currentAction = "match";
      self.block.addSearchScopes(scopes);
      let statements:any[] = [];
      self.MANY(() => {
        let statement: any = self.SUBRULE(self.statement);
        if(statement) {
          statements.push(statement);
          statement.scopes = scopes;
        }
      });
      return makeNode("searchSection", {statements, scopes, from});
    });

    self.RULE("statement", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.comparison); }},
        {ALT: () => { return self.SUBRULE(self.notStatement); }},
      ])
    });

    //-----------------------------------------------------------
    // Action section
    //-----------------------------------------------------------

    self.RULE("actionSection", () => {
      // @TODO fill in from
      let from:any[] = [];
      let action = self.CONSUME(Action).image;
      let actionKey = action;
      let scopes:any = ["session"];
      self.OPTION(() => { scopes = self.SUBRULE(self.scopeDeclaration) })
      self.activeScopes = scopes;
      self.currentAction = action!;
      let statements:any[] = [];
      self.MANY(() => {
        let statement = self.SUBRULE(self.actionStatement, [actionKey]) as any;
        if(statement) {
          statements.push(statement);
          statement.scopes = scopes;
        }
      });
      return makeNode("actionSection", {statements, scopes, from});
    });


    self.RULE("actionStatement", (actionKey) => {
      return self.OR([
        {ALT: () => {
          let record = self.SUBRULE(self.record, [false, actionKey, "+="]);
          return record;
        }},
        {ALT: () => { return self.SUBRULE(self.actionEqualityRecord, [actionKey]); }},
        {ALT: () => {
          let record = self.SUBRULE(self.actionOperation, [actionKey]);
          (self.block as any)[actionKey](record);
          return record;
        }},
        {ALT: () => { return self.SUBRULE(self.actionLookup, [actionKey]); }},
      ])
    });

    //-----------------------------------------------------------
    // Action operations
    //-----------------------------------------------------------

    self.RULE("actionOperation", (actionKey) => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.recordOperation, [actionKey]) }},
        {ALT: () => { return self.SUBRULE(self.attributeOperation, [actionKey]) }},
      ]);
    });

    self.RULE("attributeOperation", (actionKey) => {
      let mutator = self.SUBRULE(self.attributeMutator) as any;
      let {attribute, parent} = mutator;
      return self.OR([
        {ALT: () => {
          let variable = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
          let scan = makeNode("scan", {entity: parent, attribute: makeNode("constant", {value: attribute.image, from: [attribute]}), value: variable, scopes: self.activeScopes, from: [mutator]});
          self.block.addUsage(variable, scan);
          self.block.scan(scan);
          self.CONSUME(Merge);
          let record = self.SUBRULE(self.record, [true, actionKey, "+=", undefined, variable]) as any;
          record.variable = variable;
          record.action = "<-";
          return record;
        }},
        {ALT: () => {
          let op = self.CONSUME(Set);
          let none = self.CONSUME(None);
          return makeNode("action", {action: "erase", entity: asValue(parent), attribute: attribute.image, from: [mutator, op, none]});
        }},
        {ALT: () => {
          let op = self.CONSUME2(Set);
          let value = self.SUBRULE(self.infix);
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
        {ALT: () => {
          let op = self.CONSUME3(Set);
          let value = self.SUBRULE2(self.record, [false, actionKey, "+=", parent]);
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
        {ALT: () => {
          let variable = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
          let scan = makeNode("scan", {entity: parent, attribute: makeNode("constant", {value: attribute.image, from: [attribute]}), value: variable, scopes: self.activeScopes, from: [mutator]});
          self.block.addUsage(variable, scan);
          self.block.scan(scan);
          let op = self.CONSUME(Mutate);
          let tag : any = self.SUBRULE(self.tag);
          return makeNode("action", {action: op.image, entity: variable, attribute: "tag", value: makeNode("constant", {value: tag.tag, from: [tag]}), from: [mutator, op, tag]});
        }},
        {ALT: () => {
          let op = self.CONSUME2(Mutate);
          let value: any = self.SUBRULE2(self.actionAttributeExpression, [actionKey, op.image, parent]);
          if(value.type === "record" && !value.extraProjection) {
            value.extraProjection = [parent];
          }
          if(value.type === "parenthesis") {
            let autoIndex = 0;
            for(let item of value.items) {
              if(item.type === "record" && !value.extraProjection) {
                item.extraProjection = [parent];
              }
              if(item.from[0] && item.from[0].type === "record") {
                let record = item.from[0];
                record.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: autoIndex, from: [record]}), from: [record]}));
                autoIndex++;
              }
            }
          }
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
      ])
    });

    self.RULE("recordOperation", (actionKey) => {
      let variable = self.SUBRULE(self.variable) as any;
      return self.OR([
        {ALT: () => {
          let set = self.CONSUME(Set);
          let none = self.CONSUME(None);
          return makeNode("action", {action: "erase", entity: asValue(variable), from: [variable, set, none]});
        }},
        {ALT: () => {
          self.CONSUME(Merge);
          let record = self.SUBRULE(self.record, [true, actionKey, "+=", undefined, variable]) as any;
          record.needsEntity = true;
          record.action = "<-";
          return record;
        }},
        {ALT: () => {
          let op = self.CONSUME(Mutate);
          let tag : any = self.SUBRULE(self.tag);
          return makeNode("action", {action: op.image, entity: asValue(variable), attribute: "tag", value: makeNode("constant", {value: tag.tag, from: [tag]}), from: [variable, op, tag]});
        }},
      ])
    });

    self.RULE("actionLookup", (actionKey) => {
      let lookup = self.CONSUME(Lookup);
      let record: any = self.SUBRULE(self.record, [true]);
      let info: any = {};
      for(let attribute of record.attributes) {
        info[attribute.attribute] = attribute.value;
      }
      let actionType = "+=";
      self.OPTION(() => {
        self.CONSUME(Set);
        self.CONSUME(None);
        if(info["value"] !== undefined) {
          actionType = "-=";
        } else {
          actionType = "erase";
        }
      })
      let action = makeNode("action", {action: actionType, entity: info.record, attribute: info.attribute, value: info.value, node: info.node, scopes: self.activeScopes, from: [lookup, record]});
      (self.block as any)[actionKey](action);
      return action;
    });

    self.RULE("actionAttributeExpression", (actionKey, action, parent) => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.record, [false, actionKey, action, parent]); }},
        {ALT: () => { return self.SUBRULE(self.infix); }},
      ])
    })

    self.RULE("actionEqualityRecord", (actionKey) => {
      let variable = self.SUBRULE(self.variable);
      self.CONSUME(Equality);
      let record : any = self.SUBRULE(self.record, [true, actionKey, "+="]);
      record.variable = variable;
      (self.block as any)[actionKey](record);
      return record;
    });

    //-----------------------------------------------------------
    // Record + attribute
    //-----------------------------------------------------------

    self.RULE("record", (noVar = false, blockKey = "scan", action = false, parent?, passedVariable?) => {
      let attributes:any[] = [];
      let start = self.CONSUME(OpenBracket);
      let from: NodeDependent[] = [start];
      let info: any = {attributes, action, scopes: self.activeScopes, from};
      if(parent) {
        info.extraProjection = [parent];
      }
      if(passedVariable) {
        info.variable = passedVariable;
        info.variable.nonProjecting = true;
      } else if(!noVar) {
        info.variable = self.block.toVariable(`record|${start.startLine}|${start.startColumn}`, true);
        info.variable.nonProjecting = true;
      }
      let nonProjecting = false;
      self.MANY(() => {
        self.OR([
          {ALT: () => {
            let attribute: any = self.SUBRULE(self.attribute, [false, blockKey, action, info.variable]);
            // Inline handles attributes itself and so won't return any attribute for us to add
            // to this object
            if(!attribute) return;

            if(attribute.constructor === Array) {
              for(let attr of attribute as any[]) {
                attr.nonProjecting = nonProjecting;
                attributes.push(attr);
                from.push(attr);
              }
            } else {
              attribute.nonProjecting = nonProjecting;
              attributes.push(attribute);
              from.push(attribute);
            }
          }},
          {ALT: () => {
            nonProjecting = true;
            let pipe = self.CONSUME(Pipe);
            from.push(pipe);
            return pipe;
          }},
        ]);
      })
      from.push(self.CONSUME(CloseBracket));
      let record : any = makeNode("record", info);
      if(!noVar) {
        self.block.addUsage(info.variable, record);
        (self.block as any)[blockKey](record);
      }
      return record;
    });

    self.RULE("attribute", (noVar, blockKey, action, recordVariable) => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeEquality, [noVar, blockKey, action, recordVariable]); }},
        {ALT: () => { return self.SUBRULE(self.attributeComparison); }},
        {ALT: () => { return self.SUBRULE(self.attributeNot, [recordVariable]); }},
        {ALT: () => { return self.SUBRULE(self.singularAttribute); }},
        {ALT: () => {
          let value: any = self.SUBRULE(self.value);
          let token = value.from[0];

          let message = "Value missing attribute";

          if (value.hasOwnProperty("value")) {
            message = `"${value.value}" needs to be labeled with an attribute`;
          }

          self.customErrors.push({
            message,
            name: "Unlabeled value",
            resyncedTokens: [],
            context: {
              ruleOccurrenceStack: [],
              ruleStack: []
            },
            token
          });
        }},
      ]);
    });

    self.RULE("singularAttribute", (forceGenerate) => {
      return self.OR([
        {ALT: () => {
          let tag : any = self.SUBRULE(self.tag);
          return makeNode("attribute", {attribute: "tag", value: makeNode("constant", {value: tag.tag, from: [tag]}), from: [tag]});
        }},
        {ALT: () => {
          let variable : any = self.SUBRULE(self.variable, [forceGenerate]);
          return makeNode("attribute", {attribute: variable.from[0].image, value: variable, from: [variable]});
        }},
      ]);
    });

    self.RULE("attributeMutator", () => {
      let scans:any[] = [];
      let entity:any, attribute:any, value:any;
      let needsEntity = true;
      let from:any[] = [];
      entity = self.SUBRULE(self.variable);
      let dot = self.CONSUME(Dot);
      from.push(entity, dot);
      self.MANY(() => {
        attribute = self.CONSUME(Identifier);
        from.push(attribute);
        from.push(self.CONSUME2(Dot));
        value = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
        self.block.addUsage(value, attribute);
        let scopes = self.activeScopes;
        if(self.currentAction !== "match") {
          scopes = self.block.searchScopes;
        }
        let scan = makeNode("scan", {entity, attribute: makeNode("constant", {value: attribute.image, from: [value]}), value, needsEntity, scopes, from: [entity, dot, attribute]});
        self.block.scan(scan);
        needsEntity = false;
        entity = value;
      });
      attribute = self.CONSUME2(Identifier);
      from.push(attribute);
      return makeNode("attributeMutator", {attribute: attribute, parent: entity, from});
    });

    self.RULE("attributeAccess", () => {
      let scans:any[] = [];
      let entity:any, attribute:any, value:any;
      let needsEntity = true;
      entity = self.SUBRULE(self.variable);
      let parentId = entity.name;
      self.AT_LEAST_ONE(() => {
        let dot = self.CONSUME(Dot);
        attribute = self.CONSUME(Identifier);
        parentId = `${parentId}|${attribute.image}`;
        value = self.block.toVariable(parentId, true);
        self.block.addUsage(value, attribute);
        let scopes = self.activeScopes;
        if(self.currentAction !== "match") {
          scopes = self.block.searchScopes;
        }
        let scan = makeNode("scan", {entity, attribute: makeNode("constant", {value: attribute.image, from: [attribute]}), value, needsEntity, scopes, from: [entity, dot, attribute]});
        self.block.scan(scan);
        needsEntity = false;
        entity = value;
      });
      return value;
    });

    self.RULE("attributeEquality", (noVar, blockKey, action, parent) => {
      let attributes:any[] = [];
      let autoIndex = 1;
      let attributeNode:any;
      let attribute: any = self.OR([
        {ALT: () => {
          attributeNode = self.CONSUME(Identifier);
          return attributeNode.image;
        }},
        {ALT: () => {
          attributeNode = self.CONSUME(Num);
          return parseFloat(attributeNode.image) as any;
        }}
      ]);
      let equality = self.CONSUME(Equality);
      let result : any;
      self.OR2([
        {ALT: () => {
          result = self.SUBRULE(self.infix);
          // if the result is a parenthesis, we have to make sure that if there are sub-records
          // inside that they get eve-auto-index set on them and they also have the parent transfered
          // down to them. If we don't do this, we'll end up with children that are shared between
          // the parents instead of one child per parent.
          if(result.type === "parenthesis") {
            for(let item of result.items) {
              // this is a bit sad, but by the time we see the parenthesis, the records have been replaced
              // with their variables. Those variables are created from the record object though, so we can
              // check the from of the variable for a reference to the record.
              if(item.type === "variable" && item.from[0] && item.from[0].type === "record") {
                let record = item.from[0];
                // if we have a parent, we need to make sure it ends up part of our extraProjection set
                if(parent && !item.extraProjection) {
                  record.extraProjection = [parent];
                } else if(parent) {
                  record.extraProjection.push(parent);
                }
                // Lastly we need to add the eve-auto-index attribute to make sure this is consistent with the case
                // where we leave the parenthesis off and just put records one after another.
                record.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: autoIndex, from: [record]}), from: [record]}));
                autoIndex++;
              }
            }
          }
        }},
        {ALT: () => {
          result = self.SUBRULE(self.record, [noVar, blockKey, action, parent]);
          self.MANY(() => {
            autoIndex++;
            let record : any = self.SUBRULE2(self.record, [noVar, blockKey, action, parent]);
            record.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: autoIndex, from: [record]}), from: [record]}));
            attributes.push(makeNode("attribute", {attribute, value: asValue(record), from: [attributeNode, equality, record]}));
          })
          if(autoIndex > 1) {
            result.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: 1, from: [result]}), from: [result]}));
          }
        }},
      ]);
      attributes.push(makeNode("attribute", {attribute, value: asValue(result), from: [attributeNode, equality, result]}))
      return attributes;
    });

    self.RULE("attributeComparison", () => {
      let attribute = self.CONSUME(Identifier);
      let comparator = self.CONSUME(Comparison);
      let result = self.SUBRULE(self.expression);
      let variable = self.block.toVariable(`attribute|${attribute.startLine}|${attribute.startColumn}`, true);
      let expression = makeNode("expression", {op: `compare/${comparator.image}`, args: [asValue(variable), asValue(result)], from: [attribute, comparator, result]})
      self.block.addUsage(variable, expression);
      self.block.expression(expression);
      return makeNode("attribute", {attribute: attribute.image, value: variable, from: [attribute, comparator, expression]});
    });

    self.RULE("attributeNot", (recordVariable) => {
      let block = pushBlock();
      block.type = "not";
      let not = self.CONSUME(Not);
      let start = self.CONSUME(OpenParen);
      let attribute: any = self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeComparison); }},
        {ALT: () => { return self.SUBRULE(self.singularAttribute, [true]); }},
      ]);
      let end = self.CONSUME(CloseParen);
      // we have to add a record for this guy
      let scan : any = makeNode("scan", {entity: recordVariable, attribute: makeNode("constant", {value: attribute.attribute, from: [attribute]}), value: attribute.value, needsEntity: true, scopes: self.activeScopes, from: [attribute]});
      block.variables[recordVariable.name] = recordVariable;
      block.scan(scan);
      block.from = [not, start, attribute, end];
      block.startOffset = not.startOffset;
      block.endOffset = toEnd(end);
      popBlock();
      self.block.scan(block);
      return;
    });

    //-----------------------------------------------------------
    // Name and tag
    //-----------------------------------------------------------

    self.RULE("name", () => {
      let at = self.CONSUME(Name);
      let name = self.CONSUME(Identifier);
      self.customErrors.push({message: `Databases have been deprecated, so @${name.image} has no meaning here`, name: "Database deprecation", resyncedTokens: [], context:{ruleOccurrenceStack: [], ruleStack: []}, token:name})
      return makeNode("name", {name: name.image, from: [at, name]});
    });

    self.RULE("tag", () => {
      let hash = self.CONSUME(Tag);
      let tag = self.CONSUME(Identifier);
      return makeNode("tag", {tag: tag.image, from: [hash, tag]});
    });

    //-----------------------------------------------------------
    // Function
    //-----------------------------------------------------------

    self.RULE("functionRecord", (): any => {
      let name = self.OR([
          {ALT: () => { return self.CONSUME(FunctionIdentifier); }},
          {ALT: () => { return self.CONSUME(Lookup); }}
      ]);
      let record: any = self.SUBRULE(self.record, [true]);
      if(name.image === "lookup") {
        let info: any = {};
        for(let attribute of record.attributes) {
          info[attribute.attribute] = attribute.value;
        }
        let scan = makeNode("scan", {entity: info.record, attribute: info.attribute, value: info.value, node: info.node, scopes: self.activeScopes, from: [name, record]});
        self.block.scan(scan);
        return scan;
      } else {
        let variable = self.block.toVariable(`return|${name.startLine}|${name.startColumn}`, true);
        let functionRecord = makeNode("functionRecord", {op: name.image, record, variable, from: [name, record]});
        self.block.addUsage(variable, functionRecord);
        self.block.expression(functionRecord);
        return functionRecord;
      }
    });

    //-----------------------------------------------------------
    // Comparison
    //-----------------------------------------------------------

    self.RULE("comparison", (nonFiltering) : any => {
      let left = self.SUBRULE(self.expression);
      let from = [left];
      let rights:any[] = [];
      self.MANY(() => {
        let comparator = self.OR([
          {ALT: () => { return self.CONSUME(Comparison); }},
          {ALT: () => { return self.CONSUME(Equality); }}
        ]);
        let value = self.OR2([
          {ALT: () => { return self.SUBRULE2(self.expression); }},
          {ALT: () => { return self.SUBRULE(self.ifExpression); }}
        ]);
        from.push(comparator, value);
        rights.push({comparator, value});
      })
      if(rights.length) {
        let expressions = [];
        let curLeft: any = left;
        for(let pair of rights) {
          let {comparator, value} = pair;
          let expression = null;
          // if this is a nonFiltering comparison, then we return an expression
          // with a variable for its return value
          if(nonFiltering) {
            let variable = self.block.toVariable(`comparison|${comparator.startLine}|${comparator.startColumn}`, true);
            expression = makeNode("expression", {variable, op: `compare/${comparator.image}`, args: [asValue(curLeft), asValue(value)], from: [curLeft, comparator, value]});
            self.block.addUsage(variable, expression);
            self.block.expression(expression);
          } else if(tokenMatcher(comparator, Equality)) {
            if(value.type === "choose" || value.type === "union") {
              value.outputs = ifOutputs(left);
              self.block.scan(value);
            } else if(value.type === "functionRecord" && curLeft.type === "parenthesis") {
              value.returns = curLeft.items.map(asValue);
              self.block.equality(asValue(value.returns[0]), asValue(value));
            } else if(curLeft.type === "parenthesis") {
              throw new Error("Left hand parenthesis without an if or function on the right");
            } else {
              self.block.equality(asValue(curLeft), asValue(value));
            }
          } else {
            expression = makeNode("expression", {op: `compare/${comparator.image}`, args: [asValue(curLeft), asValue(value)], from: [curLeft, comparator, value]});
            self.block.expression(expression);
          }
          curLeft = value;
          if(expression) {
            expressions.push(expression);
          }
        }
        return makeNode("comparison", {expressions, from});
      };
      return left;
    });

    //-----------------------------------------------------------
    // Special Forms
    //-----------------------------------------------------------

    self.RULE("notStatement", () => {
      let block = pushBlock();
      block.type = "not";
      let from: NodeDependent[] = [
        self.CONSUME(Not),
        self.CONSUME(OpenParen),
      ];
      self.MANY(() => {
        from.push(self.SUBRULE(self.statement) as ParseNode);
      });
      from.push(self.CONSUME(CloseParen));
      popBlock();
      block.from = from;
      block.startOffset = from[0].startOffset;
      block.endOffset = toEnd(from[from.length - 1]);
      self.block.scan(block);
      return;
    });

    //-----------------------------------------------------------
    // If ... then
    //-----------------------------------------------------------

    self.RULE("ifExpression", () => {
      let branches:any[] = [];
      let exclusive = false;
      let from = branches;
      branches.push(self.SUBRULE(self.ifBranch));
      self.MANY(() => {
        branches.push(self.OR([
          {ALT: () => { return self.SUBRULE2(self.ifBranch); }},
          {ALT: () => {
            exclusive = true;
            return self.SUBRULE(self.elseIfBranch);
          }},
        ]));
      });
      self.OPTION(() => {
        exclusive = true;
        branches.push(self.SUBRULE(self.elseBranch));
      });
      let expressionType = exclusive ? "choose" : "union";
      return makeNode(expressionType, {branches, from});
    });

    self.RULE("ifBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [
        self.CONSUME(If)
      ]
      self.AT_LEAST_ONE(() => {
        let statement = self.SUBRULE(self.statement) as ParseNode;
        if(statement) {
          from.push(statement);
        }
      })
      from.push(self.CONSUME(Then));
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      block.startOffset = from[0].startOffset;
      block.endOffset = toEnd(from[from.length - 1]);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: false, from});
    });

    self.RULE("elseIfBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [
        self.CONSUME(Else),
        self.CONSUME(If),
      ]
      self.AT_LEAST_ONE(() => {
        let statement = self.SUBRULE(self.statement) as ParseNode;
        if(statement) {
          from.push(statement);
        }
      })
      from.push(self.CONSUME(Then));
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      block.startOffset = from[0].startOffset;
      block.endOffset = toEnd(from[from.length - 1]);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: true, from});
    });

    self.RULE("elseBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [self.CONSUME(Else)];
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      block.startOffset = from[0].startOffset;
      block.endOffset = toEnd(from[from.length - 1]);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: true, from});
    });

    //-----------------------------------------------------------
    // Infix and operator precedence
    //-----------------------------------------------------------

    self.RULE("infix", () => {
      return self.SUBRULE(self.addition);
    });

    self.RULE("addition", () : any => {
      let left = self.SUBRULE(self.multiplication);
      let from = [left];
      let ops:any[] = [];
      self.MANY(function() {
        let op = self.CONSUME(AddInfix);
        let right = self.SUBRULE2(self.multiplication);
        from.push(op, right);
        ops.push({op, right})
      });
      if(!ops.length) {
        return left;
      } else {
        let expressions = [];
        let curVar;
        let curLeft = left;
        for(let pair of ops) {
          let {op, right} = pair;
          curVar = self.block.toVariable(`addition|${op.startLine}|${op.startColumn}`, true);
          let expression = makeNode("expression", {op: `math/${op.image}`, args: [asValue(curLeft), asValue(right)], variable: curVar, from: [curLeft, op, right]});
          expressions.push(expression);
          self.block.addUsage(curVar, expression);
          self.block.expression(expression)
          curLeft = expression;
        }
        return makeNode("addition", {expressions, variable: curVar, from});
      }
    });

    self.RULE("multiplication", () : any => {
      let left = self.SUBRULE(self.infixValue);
      let from = [left];
      let ops:any = [];
      self.MANY(function() {
        let op = self.CONSUME(MultInfix);
        let right = self.SUBRULE2(self.infixValue);
        from.push(op, right);
        ops.push({op, right})
      });
      if(!ops.length) {
        return left;
      } else {
        let expressions = [];
        let curVar;
        let curLeft = left;
        for(let pair of ops) {
          let {op, right} = pair;
          curVar = self.block.toVariable(`addition|${op.startLine}|${op.startColumn}`, true);
          let expression = makeNode("expression", {op: `math/${op.image}`, args: [asValue(curLeft), asValue(right)], variable: curVar, from: [curLeft, op, right]});
          expressions.push(expression);
          self.block.addUsage(curVar, expression);
          self.block.expression(expression)
          curLeft = expression;
        }
        return makeNode("multiplication", {expressions, variable: curVar, from});
      }
    });

    self.RULE("parenthesis", () => {
      let items:any[] = [];
      let from:any[] = [];
      from.push(self.CONSUME(OpenParen));
      self.AT_LEAST_ONE(() => {
        let item = self.SUBRULE(self.expression);
        items.push(asValue(item));
        from.push(item);
      })
      from.push(self.CONSUME(CloseParen));
      if(items.length === 1) {
        return items[0];
      }
      return makeNode("parenthesis", {items, from});
    });

    self.RULE("infixValue", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeAccess); }},
        {ALT: () => { return self.SUBRULE(self.functionRecord); }},
        {ALT: () => { return self.SUBRULE(self.variable); }},
        {ALT: () => { return self.SUBRULE(self.value); }},
        {ALT: () => { return self.SUBRULE(self.parenthesis); }},
      ]);
    })

    //-----------------------------------------------------------
    // Expression
    //-----------------------------------------------------------

    self.RULE("expression", () => {
      let blockKey:any, action:any;
      if(self.currentAction !== "match") {
        blockKey = self.currentAction;
        action = "+=";
      }
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.infix); }},
        {ALT: () => { return self.SUBRULE(self.record, [false, blockKey, action]); }},
      ]);
    });

    //-----------------------------------------------------------
    // Variable
    //-----------------------------------------------------------

    self.RULE("variable", (forceGenerate = false) => {
      let token = self.CONSUME(Identifier);
      let name = token.image;
      if(forceGenerate) {
        name = `${token.image}-${token.startLine}-${token.startColumn}`;
      }
      let variable = self.block.toVariable(name!, forceGenerate);
      self.block.addUsage(variable, token);
      return variable;
    });

    //-----------------------------------------------------------
    // Values
    //-----------------------------------------------------------

    self.RULE("stringInterpolation", () : any => {
      let args:any[] = [];
      let start = self.CONSUME(OpenString);
      let from: NodeDependent[] = [start];
      self.MANY(() => {
        let arg = self.OR([
          {ALT: () => {
            let str = self.CONSUME(StringChars)!;
            return makeNode("constant", {value: cleanString(str.image!), from: [str]});
          }},
          {ALT: () => {
            self.CONSUME(StringEmbedOpen);
            let expression = self.SUBRULE(self.infix);
            self.CONSUME(StringEmbedClose);
            return expression;
          }},
        ]);
        args.push(asValue(arg));
        from.push(arg as ParseNode);
      });
      from.push(self.CONSUME(CloseString));
      if(args.length === 1 && args[0].type === "constant") {
        return args[0];
      } else if(args.length === 0) {
        return makeNode("constant", {value: "", from});
      }
      let variable = self.block.toVariable(`concat|${start.startLine}|${start.startColumn}`, true);
      let expression = makeNode("expression", {op: "eve/internal/concat", args, variable, from});
      self.block.addUsage(variable, expression);
      self.block.expression(expression);
      return expression;
    });

    self.RULE("value", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.stringInterpolation) }},
        {ALT: () => { return self.SUBRULE(self.num) }},
        {ALT: () => { return self.SUBRULE(self.bool) }},
      ])
    })

    self.RULE("bool", () => {
      let value = self.CONSUME(Bool);
      return makeNode("constant", {value: value.image === "true", from: [value]});
    })

    self.RULE("num", () => {
      let num = self.CONSUME(Num);
      return makeNode("constant", {value: parseFloat(num.image!), from: [num]}) ;
    });

    //-----------------------------------------------------------
    // Chevrotain analysis
    //-----------------------------------------------------------

    Parser.performSelfAnalysis(this);
  }
}

//-----------------------------------------------------------
// Public API
//-----------------------------------------------------------

export function nodeToBoundaries(node:any, offset = 0) {
  return [node.startOffset, toEnd(node)];
}

let eveParser = new Parser([]);

export function parseBlock(block:any, blockId:string, offset = 0, spans:any[] = [], extraInfo:any = {}) {
  let lex: any = EveBlockLexer.tokenize(block);
  let token: any;
  let tokenIx = 0;
  for(token of lex.tokens) {
    let tokenId = `${blockId}|token|${tokenIx++}`;
    token.id = tokenId;
    token.startOffset += offset;
    spans.push(token.startOffset, token.startOffset + token.image.length, token.label, tokenId);
  }
  for(token of lex.groups.comments) {
    let tokenId = `${blockId}|token|${tokenIx++}`;
    token.id = tokenId;
    token.startOffset += offset;
    spans.push(token.startOffset, token.startOffset + token.image.length, token.label, tokenId);
  }
  eveParser.input = lex.tokens;
  let results;
  try {
    eveParser.customErrors = [];
    // The parameters here are a strange quirk of how Chevrotain works, I believe the
    // 1 tells chevrotain what level the rule is starting at, we then pass our params
    // to the codeBlock parser function as an array
    results = eveParser.codeBlock(1, [blockId]);
  } catch(e) {
    console.error("The parser threw an error: " + e);
  }
  if(results) {
    results.start = offset;
    results.startOffset = offset;
    results.tokens = lex.tokens;
    for(let scan of results.scanLike) {
      let type = "scan-boundary";
      if(scan.type === "record") {
        type = "record-boundary";
      }
      spans.push(scan.startOffset, scan.endOffset, type, scan.id);
    }
    for(let action of results.binds) {
      let type = "action-boundary";
      if(action.type === "record") {
        type = "action-record-boundary";
      }
      spans.push(action.startOffset, action.endOffset, type, action.id);
      extraInfo[action.id] = {kind: "bind"};
    }
    for(let action of results.commits) {
      let type = "action-boundary";
      if(action.type === "record") {
        type = "action-record-boundary";
      }
      spans.push(action.startOffset, action.endOffset, type, action.id);
      extraInfo[action.id] = {kind: "commits"};
    }
  }
  let errors = parserErrors(eveParser.errors.concat(eveParser.customErrors), {blockId, blockStart: offset, spans, extraInfo, tokens: lex.tokens});
  lex.groups.comments.length = 0;
  return {
    results,
    lex,
    errors,
  }
}

let docIx = 0;
export function parseDoc(doc:string, docId = `doc|${docIx++}`) {
  let {text, spans, blocks, extraInfo} = parseMarkdown(doc, docId);
  let parsedBlocks = [];
  let allErrors = [];
  for(let block of blocks) {
    extraInfo[block.id] = {info: block.info, block};
    if(block.info.indexOf("disabled") > -1) {
      extraInfo[block.id].disabled = true;
    }
    if(block.info !== "" && block.info.indexOf("eve") === -1) continue;
    let {results, lex, errors} = parseBlock(block.literal, block.id, block.startOffset, spans, extraInfo);
    // if this block is disabled, we want the parsed spans and such, but we don't want
    // the block to be in the set sent to the builder
    if(!extraInfo[block.id].disabled) {
      if(errors.length) {
        allErrors.push(errors);
      } else if(results) {
        results.endOffset = block.endOffset;
        parsedBlocks.push(results);
      }
    }
  }

  let eavs:any[] = [];
  for(let block of parsedBlocks) {
    //if(typeof process === "undefined") console.log(block);
    toFacts(eavs, block);
  }

  for(let errorSet of allErrors) {
    for(let error of errorSet) {
      errorToFacts(eavs, error, extraInfo[error.blockId].block);
    }
  }

  return {
    results: {blocks: parsedBlocks, text, spans, extraInfo, eavs},
    errors: allErrors,
  }
}

export function errorToFacts(eavs:any[], error:EveError, block:any) {
  let text = block.literal;
  let offset = block.startOffset;
  let blockStartLine = block.sourcepos[0][0];
  let blockLines = text.split("\n");
  let pos = 0;
  let start = error.start - offset;
  let stop = error.stop - offset;
  if(isNaN(stop)) stop = text.length + offset;
  if(isNaN(start)) start = offset;
  let curLine = 0;
  let startLine = 0;
  let startChar = 0;
  let stopLine = 0;
  let stopChar = 0;
  while(curLine < blockLines.length && pos < start) {
    pos += blockLines[curLine++].length + 1;
  }
  startLine = blockStartLine + curLine;
  startChar = start - (pos - (blockLines[curLine - 1] || "").length) + 2;
  while(curLine < blockLines.length && pos < stop) {
    pos += (blockLines[curLine++] || "").length + 1;
  }
  stopLine = blockStartLine + curLine;
  stopChar = stop - (pos - (blockLines[curLine - 1] || "").length) + 2;

  let sampleText = [];
  let relativeStart = startLine - blockStartLine;
  let relativeStop = stopLine - blockStartLine;
  if(relativeStart != 0) {
    sampleText.push(blockLines[relativeStart - 1]);
    sampleText.push(blockLines[relativeStart]);
  }

  if(relativeStop > relativeStart) {
    let cur = relativeStart;
    while(cur <= relativeStop) {
      sampleText.push(blockLines[cur]);
      cur++;
    }
  }

  if(relativeStop < blockLines.length && blockLines[relativeStop + 1]) {
    sampleText.push(blockLines[relativeStop + 1]);
  }

  let errorId = uuid();
  let startId = uuid();
  let stopId = uuid();
  eavs.push([errorId, "tag", "eve/compiler/error"]);
  eavs.push([errorId, "message", error.message]);
  eavs.push([errorId, "start", startId]);
  eavs.push([startId, "line", startLine]);
  eavs.push([startId, "char", startChar]);
  eavs.push([errorId, "stop", stopId]);
  eavs.push([stopId, "line", stopLine]);
  eavs.push([stopId, "char", stopChar]);
  eavs.push([errorId, "sample", sampleText.join("\n")])
}

export function recordToFacts(eavs:any[], vars:any, scanLike:any) {
  let rec = uuid();
  eavs.push([rec, "tag", "eve/compiler/record"]);
  eavs.push([rec, "record", vars[scanLike.variable.name]]);

  for(let attr of scanLike.attributes) {
    if(attr.type === "attribute") {
      let values;
      if(attr.value && attr.value.type === "parenthesis") {
        values = attr.value.items;
      } else {
        values = [attr.value];
      }
      for(let value of values) {
        let attrId = uuid();
        eavs.push([attrId, "attribute", attr.attribute]);
        eavs.push([attrId, "value", asFactValue(vars, value)]);
        eavs.push([rec, "attribute", attrId]);
      }
    }
  }

  return rec;
}

function asFactValue(vars:any, value:any) {
  if(typeof value !== "object") return value;
  return value.type == "constant" ? value.value : vars[value.name];
}

export function outputToFacts(eavs:any[], vars:any, scanLike:any, blockId:string) {
  let rec = uuid();
  eavs.push([rec, "tag", "eve/compiler/output"]);
  eavs.push([rec, "record", vars[scanLike.variable.name]]);
  if(scanLike.action === "-=" || scanLike.action === "erase") {
    eavs.push([rec, "tag", "eve/compiler/remove"]);
  } else if(scanLike.action === ":=" || scanLike.action === "<-") {
    let attrs = [];
    for(let attribute of scanLike.attributes) {
      attribute.nonProjecting = true;
      if(attribute.type === "attribute") {
        if(scanLike.action === ":=" || (attribute.attribute !== "tag")) {
          attrs.push({type: "attribute", attribute: attribute.attribute, nonProjecting:true});
        }
      }
    }
    outputToFacts(eavs, vars, {variable:scanLike.variable, action: "erase", attributes:attrs}, blockId);
  }

  for(let attr of scanLike.attributes) {
    if(attr.type === "attribute") {
      let values;
      if(attr.value && attr.value.type === "parenthesis") {
        values = attr.value.items;
      } else {
        values = [attr.value];
      }
      for(let value of values) {
        let attrId = uuid();
        eavs.push([attrId, "attribute", asFactValue(vars, attr.attribute)]);
        if(value) {
          eavs.push([attrId, "value", asFactValue(vars, value)]);
        }
        if(attr.nonProjecting) {
          eavs.push([attrId, "tag", "eve/compiler/attribute/non-identity"]);
        }
        eavs.push([rec, "attribute", attrId]);
      }
    }
  }
  eavs.push([blockId, "constraint", rec]);
  return rec;
}

function subBlockToFacts(eavs:any[], vars:any, blockId: string, block:any) {
  for(let [left, right] of block.equalities) {
    let eqId = uuid();
    eavs.push([eqId, "tag", "eve/compiler/equality"]);
    eavs.push([eqId, "left", asFactValue(vars, left)]);
    eavs.push([eqId, "right", asFactValue(vars, right)]);
    eavs.push([blockId, "constraint", eqId]);
  }

  for(let scanLike of block.scanLike) {
    switch(scanLike.type) {
      case "record":
        let constraint = recordToFacts(eavs, vars, scanLike);
        eavs.push([blockId, "constraint", constraint]);
        break;
      case "scan":
        let lookupId = uuid();
        eavs.push([lookupId, "tag", "eve/compiler/lookup"]);
        eavs.push([lookupId, "record", asFactValue(vars, scanLike.entity)]);
        eavs.push([lookupId, "attribute", asFactValue(vars, scanLike.attribute)]);
        eavs.push([lookupId, "value", asFactValue(vars, scanLike.value)]);
        eavs.push([blockId, "constraint", lookupId]);
        break;
      case "not":
        let notId = uuid();
        eavs.push([notId, "tag", "eve/compiler/not"]);
        eavs.push([notId, "tag", "eve/compiler/block"]);
        eavs.push([blockId, "constraint", notId]);
        subBlockToFacts(eavs, vars, notId, scanLike);
        break;
      case "choose":
      case "union":
        let chooseId = uuid();
        if(scanLike.type === "choose") {
          eavs.push([chooseId, "tag", "eve/compiler/choose"]);
        } else {
          eavs.push([chooseId, "tag", "eve/compiler/union"]);
        }
        eavs.push([chooseId, "tag", "eve/compiler/branch-set"]);
        eavs.push([blockId, "constraint", chooseId]);
        for(let branch of scanLike.branches) {
          let branchId = uuid();
          eavs.push([chooseId, "branch", branchId]);
          eavs.push([branchId, "tag", "eve/compiler/block"]);
          subBlockToFacts(eavs, vars, branchId, branch.block);
          let ix = 1;
          for(let output of branch.outputs) {
            let outputId = uuid();
            eavs.push([branchId, "output", outputId]);
            eavs.push([outputId, "value", asFactValue(vars, output)]);
            eavs.push([outputId, "index", ix]);
            ix++;
          }
        }
        let ix = 1;
        for(let output of scanLike.outputs) {
          let outputId = uuid();
          eavs.push([chooseId, "output", outputId]);
          eavs.push([outputId, "value", asFactValue(vars, output)]);
          eavs.push([outputId, "index", ix]);
          ix++;
        }
        break;
    }
  }

  for(let expr of block.expressions) {
    let exprId = uuid();
    let isAggregate = expr.op.indexOf("gather/") === 0;
    eavs.push([blockId, "constraint", exprId]);
    eavs.push([exprId, "tag", "eve/compiler/expression"]);
    if(isAggregate) {
      eavs.push([exprId, "tag", "eve/compiler/aggregate"]);
    }
    eavs.push([exprId, "op", expr.op]);
    if(expr.type === "expression") {
      let ix = 1;
      for(let arg of expr.args) {
        let argId = uuid();
        eavs.push([exprId, "arg", argId]);
        eavs.push([argId, "index", ix]);
        eavs.push([argId, "value", asFactValue(vars, arg)]);
        ix++;
      }
      if(expr.variable) {
        let returnId = uuid();
        eavs.push([exprId, "return", returnId]);
        eavs.push([returnId, "index", 1]);
        eavs.push([returnId, "value", asFactValue(vars, expr.variable)]);
      }
    } else if(expr.type === "functionRecord") {
      for(let arg of expr.record.attributes) {
        let ix = 1;
        if(arg.value.type === "parenthesis") {
          for(let value of arg.value.items) {
            let argId = uuid();
            eavs.push([exprId, "arg", argId]);
            eavs.push([argId, "name", arg.attribute]);

            eavs.push([argId, "value", asFactValue(vars, value)]);
            eavs.push([argId, "index", ix]);
            ix++;
          }
        } else {
          let argId = uuid();
          eavs.push([exprId, "arg", argId]);
          eavs.push([argId, "name", arg.attribute]);

          eavs.push([argId, "value", asFactValue(vars, arg.value)]);
          eavs.push([argId, "index", ix]);
        }
      }
      if(expr.returns) {
        let ix = 1;
        for(let ret of expr.returns) {
          let returnId = uuid();
          eavs.push([exprId, "return", returnId]);
          eavs.push([returnId, "index", ix]);
          eavs.push([returnId, "value", asFactValue(vars, ret.value)]);
          ix++;
        }
      } else if(expr.variable) {
        let returnId = uuid();
        eavs.push([exprId, "return", returnId]);
        eavs.push([returnId, "index", 1]);
        eavs.push([returnId, "value", asFactValue(vars, expr.variable)]);
      }
    }
  }
}

export function toFacts(eavs:any[], block:any) {
  let blockId = uuid();
  eavs.push([blockId, "tag", "eve/compiler/rule"]);
  eavs.push([blockId, "tag", "eve/compiler/block"]);
  eavs.push([blockId, "name", block.id]);
  let blockType = "bind";
  if(block.commits.length) { blockType = "commit"; }
  eavs.push([blockId, "type", blockType]);

  let vars:any = {};
  for(let variable in block.variableLookup) {
    let varId = uuid();
    vars[variable] = varId;
    eavs.push([varId, "tag", "eve/compiler/var"]);
  }

  subBlockToFacts(eavs, vars, blockId, block);

  let outputs = block.binds.concat(block.commits);
  for(let output of outputs) {
    switch(output.type) {
      case "record":
        outputToFacts(eavs, vars, output, blockId);
      break;
      case "action":
        outputToFacts(eavs, vars, {
          action: output.action,
          variable: output.entity,
          attributes: [{type: "attribute", attribute: output.attribute, value: output.value, nonProjecting: true}]
        }, blockId)
        break;
    }
  }

  return eavs;

  // let lookup = find("eve/compiler/lookup");
  // let {record:rec, attribute, value} = lookup;

}
