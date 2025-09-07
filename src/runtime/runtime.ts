import {Index, HashIndex, DistinctIndex} from "./indexes";
import {Tracer, NoopTracer, TraceNode, TraceFrameType} from "./trace";

//------------------------------------------------------------------------
// debugging utilities
//------------------------------------------------------------------------

const TRACE = false;

// Turning this on causes all of the debug(.*) statements to print to the
// console.  This is useful to see exactly what the runtime is doing as it
// evaluates a transaction, but it incurs both a pretty serious performance
// cost and prints a lot of stuff.
const DEBUG = false;

export var debug:Function = () => {};
if(DEBUG) {
  debug = function() {
    console.log.apply(console, arguments);
  }
}

function indent(text:string, level:number) {
  let padding = new Array(level + 1).join(" ");
  return text.split("\n").join("\n" + padding);
}

export function printField(field:ScanField) {
  if(isRegister(field)) return "[" + field.offset + "]";
  if(field === undefined || field === null) return field;
  let raw = maybeReverse(field);
  return typeof raw === "string" ? `"${raw}"` : raw;
}

export function printFieldArray(fields:ScanField[]) {
  return "[" + fields.map(printField).join(", ") + "]";
}

export function printPrefix(prefix:Prefix) {
  return prefix.map((v) => GlobalInterner.reverse(v));
}

function toString(x:any):string {
  if(x && x.toString) return x.toString();
  console.warn("No toString specified for", x);
  return "";
}

export function printBlock(block:Block):string {
  return block.toString();
}
(global as any).printBlock = printBlock;

export function maybeReverse(value?:ID):ID|RawValue|undefined {
  if(value === undefined) return value;
  let raw = GlobalInterner.reverse(value);
  return (""+raw).indexOf("|") === -1 ? raw : value;
}

//------------------------------------------------------------------------
// Allocations
//------------------------------------------------------------------------

// As this is a language runtime, we want to get insight into how we're using
// memory and what allocation costs we're eating as we run. To track that, we
// use createHash and createArray to give us some rough numbers. The JIT will
// inline these functions, so the cost over just using {} or [], is fairly
// negligible. In a release build we can also strip the allocation tracking.

export var ALLOCATION_COUNT:any = {};

export function createHash(place = "unknown-hash") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return Object.create(null);
}

export function createArray(place = "unknown") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return [];
}

export function copyArray(arr:any[], place = "unknown") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return arr.slice();
}

export function copyHash(hash:any, place = "unknown") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  let neue:any = {};
  for(let key of Object.keys(hash)) {
    neue[key] = hash[key];
  }
  return neue;
}

// given two arrays, append the second's items on to the first
export function concatArray(arr:any[], arr2:any[]) {
  let ix = arr.length;
  for(let elem of arr2) {
    arr[ix] = elem;
    ix++;
  }
  return arr;
}

// overwrite the first array with the values of the second array
// and fix the length if it's different
export function moveArray(arr:any[], arr2:any[]) {
  let ix = 0;
  for(let elem of arr) {
    arr2[ix] = arr[ix];
  }
  if(arr2.length !== arr.length) arr2.length = arr.length;
  return arr2;
}

//------------------------------------------------------------------------
// Iterator
//------------------------------------------------------------------------

// To reduce allocations as much as possible, we want to reuse arrays as much
// as possible. If we reused the array by setting its length to 0 or to some
// new size that is smaller than its current length, we eat the cost of
// deallocating some chunk of memory as well as the potential cost in
// fragmentation. Instead, the Iterator class never changes the size of its
// backing array, and instead keeps its own length. You iterate through the
// array using the next() method:
//
// let current;
// while((current = iterator.next()) !== undefined) {
//   ...
// }
//
// Through the magic of the JIT, this has no performance penalty over using a
// standard for loop. You can get some of those "zero-cost abstractions" in JS
// too!

export class Iterator<T> {
  array:T[] = [];
  length:number = 0;
  ix:number = 0;

  push(value:T) {
    this.array[this.length++] = value;
  }

  clear() {
    this.length = 0;
    this.reset();
  }

  reset() {
    this.ix = 0;
  }

  next():T|undefined {
    if(this.ix < this.length) return this.array[this.ix++];
    return;
  }

  iter():ReadOnlyIterator<T> {
    return new ReadOnlyIterator(this.array, this.length);
  }
}

export class ReadOnlyIterator<T> extends Iterator<T> {
  constructor(arr:T[], length:number) {
    super();
    this.array = arr;
    this.length = length;
  }

  push(value:T) {
    throw new Error("Cannot write to a readonly iterator");
  }
}

//------------------------------------------------------------------------
// Interning
//------------------------------------------------------------------------

// Every value that touches the runtime is interned. While that may seem kind
// of crazy, there are lots of good reasons for this. The first is that it
// turns an infinite space of values into a bounded space of integers. This
// gives us a lot more options in how we index values and dramatically improves
// our memory layout. On top of that, every lookup and equality is now on
// fixed-size integers, which computers can do near instantly.  Similarly,
// nearly every function in the runtime is now monomorphic, giving the JIT free
// reign to compile our loops into very fast native code.
//
// This is of course a tradeoff. It means that when we need to do operations on
// the actual values, we have to look them up. In practice all of the above
// benefits have greatly outweighed the lookup cost, the cache-line savings
// alone makes that pretty irrelevant.  The main cost is that as values flow
// out of the system, if we don't clean them up, we'll end up leaking ids.
// Also, at current you can have a maximum of a 32bit integer's worth of unique
// values in your program. Chances are that doesn't matter in practice on the
// client side, but could be a problem in the server at some point. To combat
// this, our intener keeps a ref-count, but we're not freeing any of the IDs at
// the moment.
//
// @TODO: we don't ever release IDs in the current runtime because we're not
// sure who might be holding onto a transaction, which contain references to
// IDs. At some point we should probably reference count transactions as well
// and when they are released, that gives us an opportunity to release any
// associated IDs that are no longer in use.

/** The union of value types we support in Eve. */
export type RawValue = string|number;
/**  An interned value's ID. */
export type ID = number;

function isNumber(thing:any): thing is number {
  return typeof thing === "number";
}

export class Interner {
  // IDs are only positive integers so that they can be used as array indexes
  // for efficient lookup.
  currentID: number = 0;

  // We currently only have two value types in Eve at the moment, strings and
  // numbers.  Because keys in a javascript object are always converted to
  // strings, we have to keep dictionaries for the two types separate,
  // otherwise the number 1 and the string "1" would end up being the same
  // value;
  strings: {[value:string]: ID|undefined} = createHash(); numbers:
    {[value:number]: ID|undefined} = createHash();

  // We use this array as a lookup from an integer ID to a RawValue since the
  // IDs are guaranteed to be densely packed, this gives us much better
  // performance than using another hash.
  IDs: RawValue[] = createArray();

  // This is used as another lookup from ID to the number of references this ID
  // has in the system. As the ref count goes to zero, we can add the ID to the
  // free list so that it can be reused.
  IDRefCount: number[] = createArray(); IDFreeList: number[] = createArray();

  // During the course of evaluation, we might allocate a bunch of intermediate
  // IDs whose values might just be thrown away. For example if we generate a
  // value just to use as a filter, there's no sense in us keeping the value in
  // the interned space.  Arenas are named groups of allocations that we may
  // want to dereference all together.  Note that just because we may
  // dereference it once, that doesn't mean the ID should be released - other
  // uses of the ID may exist.
  arenas: {[arena:string]: Iterator<ID>} = createHash();

  constructor() {
    // The only arena we *know* we want from the beginning is for the output of functions.
    this.arenas["functionOutput"] = new Iterator<ID>();
  }

  _getFreeID() {
    return this.IDFreeList.pop() || this.currentID++;
  }

  reference(id:ID) {
    this.IDRefCount[id]++;
  }

  // Intern takes a value and gives you the ID associated with it. If there isn't an
  // ID it should create one for this value and in either case it should add a reference.
  intern(value: RawValue): ID {
    let coll: {[value:RawValue]: number|undefined};
    if(isNumber(value)) {
      coll = this.numbers;
    } else {
      coll = this.strings;
    }
    let found = coll[value];
    if(found === undefined) {
      found = this._getFreeID();
      coll[value] = found;
      this.IDs[found] = value;
      this.IDRefCount[found] = 1;
    } else {
      this.IDRefCount[found]++;
    }
    return found;
  }

  // Get neither creates an ID nor adds a reference to the ID, it only looks up the
  // ID for a value if it exists.
  get(value: RawValue): ID|undefined {
    let coll: {[value:RawValue]: number|undefined};
    if(isNumber(value)) {
      coll = this.numbers;
    } else {
      coll = this.strings;
    }
    return coll[value];
  }

  // Go from an ID to the RawValue
  reverse(id: ID): RawValue {
    return this.IDs[id];
  }

  // Dereference an ID and if there are no remaining references, add it to the freelist.
  release(id: ID|undefined) {
    if(id === undefined) return;

    this.IDRefCount[id]--;
    if(!this.IDRefCount[id]) {
      let value = this.IDs[id];
      let coll: {[value:RawValue]: number|undefined};
      if(isNumber(value)) {
        coll = this.numbers;
      } else {
        coll = this.strings;
      }
      coll[value] = undefined;
      this.IDs[id] = undefined as any;
      this.IDFreeList.push(id);
    }
  }

  arenaIntern(arenaName:string, value:RawValue):ID {
    // @FIXME: Unfortunately we can't use arena intern at the moment due to the
    // fact that while we can know what values end up in the primary indexes,
    // we don't know what values might be hiding in intermediate indexes that
    // runtime nodes sometimes need to keep. If we *did* deallocate an arena
    // and the value didn't make it to a primary index, but ended up in an
    // intermediate one, we'd have effectively corrupted our program. The ID
    // would be freed, and then used for some completely different value. Until
    // we can find an accurate (and cheap!) way to track what values are still
    // hanging around, we'll just have to eat the cost of interning all the
    // values we've seen. Keep in mind that this isn't as bad as it sounds, as
    // the only values that would actually be freed this way are values that
    // are calculated but never end up touching the primary indexes. This is
    // rare enough that in practice, this probably isn't a big deal.
    throw new Error("Arena interning isn't ready for primetime yet.")

    // let arena = this.arenas[arenaName];
    // if(!arena) {
    //   arena = this.arenas[arenaName] = new Iterator<ID>();
    // }
    // // @NOTE: for performance reasons it might make more sense to prevent duplicates
    // // from ending up in the list. If that's the case, we could either keep a seen
    // // hash or do a get and only intern if it hasn't been seen. This is (probably?)
    // // a pretty big performance gain in the case where a bunch of rows might repeat
    // // the same function output over and over.
    // let id = this.intern(value);
    // arena.push(id);
    // return id;
  }

  releaseArena(arenaName:string) {
    let arena = this.arenas[arenaName];
    if(!arena) {
      console.warn("Trying to release unknown arena: " + arenaName)
      return;
    }

    let id;
    while((id = arena.next()) !== undefined) {
      this.release(id);
    }
    arena.clear();
  }
}

// The runtime uses a single global interner so that all values remain comparable.
export var GlobalInterner = new Interner();
(global as any)["GlobalInterner"] = GlobalInterner;

//------------------------------------------------------------------------
// Changes
//------------------------------------------------------------------------

// Because Eve's runtime is incremental from the ground up, the primary unit of
// information in the runtime is a Change. The content of a change is in the
// form of "triples," a tuple of entity, attribute, and value (or in the RDF
// world, subject, object, predicate). For example, if we wanted to talk about
// my age, we might have a triple of ("chris", "age", 30). Beyond the content
// of the change, we also want to know who created this change and what
// transaction it came from. This gives us enough information to work out the
// provenance of this information, which is very useful for debugging as well
// as doing clever things around verification and trust. The final two pieces
// of information in a change are the round and count, which are used to help
// us maintain our program incrementally. Because Eve runs all blocks to
// fixedpoint, a single change may cause multiple "rounds" of evaluation which
// introduce more changes. By tracking what round these changes happened in, we
// can do some clever reconciling to handle removal inside recursive rules
// efficiently, which we'll go into more depth later. Count tells us how many
// of these triples we are adding or, if the number is negative, removing from
// the system.

// We track counts as Multiplicities, which are just signed integers.
export type Multiplicity = number;

// It's often useful to know just the sign of a multiplicity
function sign (x:number) {
  return typeof x === 'number' ? x ? x < 0 ? -1 : 1 : x === x ? 0 : NaN : NaN;
}


// In a change entity, attribute, value, and node are stored as e, a, v, and n
// respectively.  We often need to look these up in loops or pass around
// information about what property we might currently be talking about, so we
// have a type representing those fields.
export type EAVNField = "e"|"a"|"v"|"n";

export class Change {
  // Change expects that all values have already been interned.
  constructor(public e: ID, public a: ID, public v: ID, public n: ID, public transaction:number, public round:number, public count:Multiplicity) {}

  // As a convenience, you can generate a change from values that haven't been
  // interned yet.
  static fromValues(e: any, a: any, v: any, n: any, transaction: number, round: number, count:Multiplicity) {
    return new Change(GlobalInterner.intern(e), GlobalInterner.intern(a), GlobalInterner.intern(v),
                      GlobalInterner.intern(n), transaction, round, count);
  }

  toString() {
    // let e = GlobalInterner.reverse(this.e);
    let e = this.e;
    return `Change(${e}, ${GlobalInterner.reverse(this.a)}, ${maybeReverse(this.v)}, ${this.n}, ${this.transaction}, ${this.round}, ${this.count})`;
  }

  // For testing purposes, you often want to compare two Changes ignoring their
  // node, as you don't know exactly what node will generate a value when you
  // run. withoutE is also used in testing to check if a triple whose entity
  // may have been generated by the program *could* match this change.
  equal(other:Change, withoutNode?:boolean, withoutE?:boolean) {
   return (withoutE || this.e == other.e) &&
          this.a == other.a &&
          this.v == other.v &&
          (withoutNode || this.n == other.n) &&
          this.transaction == other.transaction &&
          this.round == other.round &&
          this.count == other.count;
  }

  reverse(interner:Interner = GlobalInterner) {
    let {e, a, v, n, transaction, round, count} = this;
    return new RawChange(interner.reverse(e), interner.reverse(a), interner.reverse(v), interner.reverse(n), transaction, round, count);
  }

  toRawEAV(interner:Interner = GlobalInterner):RawEAV {
    let {e, a, v} = this;
    return [interner.reverse(e), interner.reverse(a), interner.reverse(v)];
  }

  clone() {
    let {e, a, v, n, transaction, round, count} = this;
    return new Change(e, a, v, n, transaction, round, count);
  }
}

const BLOCK_REMOVE = new Change(0,0,0,0,0,0,-1);
const BLOCK_ADD = new Change(0,0,0,0,0,0,1);

export class RemoveChange extends Change {
  toString() {
    // let e = GlobalInterner.reverse(this.e);
    let e = this.e;
    return `RemoveChange(${e}, ${GlobalInterner.reverse(this.a)}, ${maybeReverse(this.v)}, ${this.n}, ${this.transaction}, ${this.round}, ${this.count})`;
  }
  clone() {
    let {e, a, v, n, transaction, round, count} = this;
    return new RemoveChange(e, a, v, n, transaction, round, count);
  }
}

export class RemoveVsChange extends RemoveChange {
  toRemoveChanges(context:EvaluationContext, changes:Change[]) {
    let {e,a,v,n} = this;
    let {index, distinctIndex} = context;
    let matches = index.get(e, a, IGNORE_REG, IGNORE_REG, this.transaction, Infinity);
    for(let {v} of matches) {
      let rounds = index.getDiffs(e, a, v, IGNORE_REG);
      for(let round of rounds) {
        let count = this.count * (round > 0 ? 1 : -1);
        let changeRound = Math.max(this.round, Math.abs(round) - 1);
        let change = new RemoveChange(e!, a!, v!, n!, this.transaction, changeRound, count);
        changes.push(change);
      }
    }
  }
  clone() {
    let {e, a, v, n, transaction, round, count} = this;
    return new RemoveVsChange(e, a, v, n, transaction, round, count);
  }
}

export class RemoveAVsChange extends RemoveVsChange {
  toRemoveChanges(context:EvaluationContext, changes:Change[]) {
    let {e,a,v,n} = this;
    let {index, distinctIndex} = context;
    let matches = index.get(e, IGNORE_REG, IGNORE_REG, IGNORE_REG, this.transaction, Infinity);
    for(let {a, v} of matches) {
      let rounds = index.getDiffs(e, a, v, IGNORE_REG);
      for(let round of rounds) {
        let count = this.count * (round > 0 ? 1 : -1);
        let changeRound = Math.max(this.round, Math.abs(round) - 1);
        let change = new RemoveChange(e!, a!, v!, n!, this.transaction, changeRound, count);
        changes.push(change);
      }
    }
  }

  clone() {
    let {e, a, v, n, transaction, round, count} = this;
    return new RemoveAVsChange(e, a, v, n, transaction, round, count);
  }
}

// When interacting with the outside world, we need to pass changes around that
// are no longer interned. A RawChange is the same as Change, but all the
// information in the triple has been converted back into RawValues instead of
// interned IDs.
export class RawChange {
  constructor(public e: RawValue, public a: RawValue, public v: RawValue, public n: RawValue,
              public transaction:number, public round:number, public count:Multiplicity) {}

  toString() {
    let {e, a, v, n, transaction, round, count} = this;
    let internedE = GlobalInterner.get(e);
    let internedV = GlobalInterner.get(v);
    return `RawChange(${internedE}, ${a}, ${maybeReverse(internedV) || v}, ${n}, ${transaction}, ${round}, ${count})`;
  }
}

//------------------------------------------------------------------------
// Joins
//------------------------------------------------------------------------

// Buckle up, we're going for a ride.
//
// Now that we have a change representation, we need to actually do something
// with it. Eve is a relational language, which means the primary action in
// the language is to join tuples together. Unlike in most relational databases
// where we might do joins by looking at full relations pair-wise and joining
// them together, we need to operate on changes and we want to sidestep the
// cost of figuring out a good query plan for the pair-wise joins. Both of
// these properties require us to look at joins very differently than we
// normally would in say Postgres. Instead, we're going to use a magical join
// algorithm called Generic Join [1] and extend it to work on incremental
// changes instead of just fully realized relations.
//
// The core idea behind Generic Join is that instead of breaking a query down
// into a set of binary joins on relations, we look at each unique variable in
// the query and have all of the relations that might say something about that
// variable do an intersection. Let's look at an example:
//
//  people(person-id, name)
//  dogs(person-id, dog-name, dog-age)
//
// Here we have two relations we want to join together: "people" and "dogs".
// The people relation has two fields that are represented by the variables
// "person-id" and "name." The dogs relation has three fields: "person-id",
// "dog-name", and "dog-age." In postgres, we'd take these two relations and do
// a hash or merge join based on the first column of each. In generic join we
// look at all the variables we need to solve for, in this case four of them,
// and then ask each relation which variable they could propose values for.
// These proposals include not just what variable this relation could solve
// for, but also an estimate of how many values the variable would have. In the
// interest of doing the least amount of work possible, we select the proposal
// with the smallest estimate and then for each proposed value of the variable,
// we ask all the other relations if they "accept" the value.  If they do, we
// recursively solve for the rest of the variables in depth-first fashion.
//
// In this algorithm, each relation acts as a constraint on the space of
// valid solutions. We don't just look at every row in the people table or
// every row in the dogs table, but instead look at the unique values per
// variable given some set of already solved variables. We call that
// solved set of variables a "prefix". So when we ask a constraint to propose
// values, we hand it the prefix and ask it which variable it would solve for
// next. We then ask each constraint if they accept the new prefix and continue
// to solve for the rest of the variables. By selecting the proposal with the
// smallest estimate, we can make some interesting guarantees about the upper
// bound [2] of the work we will do to satisfy our join and we side step the
// need for the insanely complex query planners that exist in most commercial
// databases. An interesting aspect of this algorithm is that it's basically
// making planning decisions for every unique value of a variable, which means
// that it is resilient to the high skew you often end up with in real-world
// data.
//
// So the key parts of Generic Join are prefixes, constraints, and proposals,
// which we'll start to layout below. We'll talk more about the ways we have
// to change Generic Join to make it work incrementally later.
//
// [1]: Generic Join is presented in "Skew Strikes Back: New Developments in
//      the Theory of Join Algorithms" https://arxiv.org/abs/1310.3314
// [2]: "Worst-case Optimal Join Algorithms "https://arxiv.org/abs/1203.1952

//------------------------------------------------------------------------
// Prefixes and registers
//------------------------------------------------------------------------

export type Prefix = ID[];

// A register is a numerical offset into a prefix. We can't just make this a
// type alias to number because we need to be able to tell the difference between
// IDs which represent static values and registers which represent dynamic values
// in the prefix. For example I might have a constraint that looks for the
// pattern (register1, "tag", "person"), which if we treated Registers as numbers
// might just look like (1, 2, 3) after the values have been interned. Instead
// we make Register a class.

export class Register {
  constructor(public offset:number) {}
}

export function isRegister(x: any): x is Register {
  return x && x.constructor === Register;
}

// In some cases we have a constraint whose value we may want to ignore.
// IGNORE_REG is a sentinel value that tells us we don't care what the value of
// something is when we're solving.
export var IGNORE_REG = null;
export type IgnoreRegister = typeof IGNORE_REG;

//------------------------------------------------------------------------
// Proposal
//------------------------------------------------------------------------

export interface Proposal {
  cardinality:number,
  forFields:Iterator<EAVNField>,
  forRegisters:Iterator<Register>,
  proposer:Constraint,
  skip?:boolean,
  info?:any,
}

//------------------------------------------------------------------------
// Constraints
//------------------------------------------------------------------------

export type RoundArray = number[];

export enum ApplyInputState {
  pass,
  fail,
  none,
}

export interface Constraint {
  isInput:boolean;
  toString():string;
  setup():void;
  getRegisters():Register[];
  applyInput(input:Change, prefix:Prefix):ApplyInputState;
  isAffected(input:Change):ApplyInputState;
  propose(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:any[]):Proposal;
  resolveProposal(context:EvaluationContext, prefix:Prefix, proposal:Proposal, transaction:number, round:number, results:any[]):ID[][];
  accept(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, solvingFor:Register[]):boolean;
  acceptInput(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number):boolean;
  getDiffs(context:EvaluationContext, prefix:Prefix):RoundArray;
}

//------------------------------------------------------------------------
// Resolved values
//------------------------------------------------------------------------

/** A scan field may contain a register, a static interned value, or the IGNORE_REG sentinel value. */
export type ScanField = Register|ID|IgnoreRegister;
/** A resolved value is a scan field that, if it contained a register, now contains the register's resolved value. */
export type ResolvedValue = ID|undefined|IgnoreRegister;

export type ResolvedEAVN = {e:ResolvedValue, a:ResolvedValue, v:ResolvedValue, n:ResolvedValue};

export class EAVN {
  constructor(public e:ID, public a:ID, public v:ID, public n:ID) {}
};

export type EAV = [ID, ID, ID];
export type RawEAV = [RawValue, RawValue, RawValue];
export type RawEAVC = [RawValue, RawValue, RawValue, number];

//------------------------------------------------------------------------
// Move Constraint
//------------------------------------------------------------------------

export class MoveConstraint {

  constructor(public from:Register|ID, public to:Register) { }

  shouldApplyInput = false;
  proposal:Proposal = {cardinality: 1, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), proposer: this};
  registers:Register[] = createArray("MoveConstriantRegisters");
  resolved:(ID|undefined)[] = createArray("MoveConstraintResolved");

  isInput = false;
  isStatic = true;

  toString() {
    return `Move(${printField(this.from)}, ${printField(this.to)})`;
  }

  setup():void {
    if(isRegister(this.from)) {
      this.isStatic = false;
    }
    this.registers.push(this.to);

    // we are always only proposing for our to register
    this.proposal.forRegisters.clear();
    this.proposal.forRegisters.push(this.to);
  }

  resolve(prefix:Prefix) {
    if(isRegister(this.from)) {
      this.resolved[0] = prefix[this.from.offset];
    } else {
      this.resolved[0] = this.from;
    }
    this.resolved[1] = prefix[this.to.offset];
    return this.resolved;
  }

  getRegisters():Register[] {
    return this.registers;
  }

  isAffected(input:Change):ApplyInputState {
    if(this.shouldApplyInput) {
      return ApplyInputState.pass;
    }
    return ApplyInputState.none;
  }

  applyInput(input:Change, prefix:Prefix):ApplyInputState {
    if(this.shouldApplyInput) {
      let value;
      if(isRegister(this.from)) {
        value = prefix[this.from.offset];
      } else {
        value = this.from;
      }
      let current = prefix[this.to.offset];
      if(value !== undefined && (current === undefined || current == value)) {
        prefix[this.to.offset] = value;
      } else {
        return ApplyInputState.fail;
      }
      return ApplyInputState.pass;
    }
    return ApplyInputState.none;
  }

  propose(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:any[]):Proposal {
    let [from, to] = this.resolve(prefix);
    this.proposal.skip = true;
    if(from !== undefined && to === undefined) {
      this.proposal.skip = false;
    }
    return this.proposal;
  }

  resolveProposal(context:EvaluationContext, prefix:Prefix, proposal:Proposal, transaction:number, round:number, results:any[]):ID[][] {
    let [from, to] = this.resolve(prefix);
    let arr = createArray("MoveResult") as Prefix;
    arr[0] = from!;
    return arr as any;
  }

  accept(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, solvingFor:Register[]):boolean {
    let [from, to] = this.resolve(prefix);
    if(from !== undefined && to !== undefined) {
      return from == to;
    }
    return true;
  }

  acceptInput(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number):boolean {
    return this.accept(context, prefix, transaction, round, this.registers);
  }

  getDiffs(context:EvaluationContext, prefix:Prefix):RoundArray {
    throw new Error("Asking for Diffs from MoveConstraint");
  }
}

//------------------------------------------------------------------------
// Scans
//------------------------------------------------------------------------

/**
 * A scan maps a set of bound variables to unbound variables.
 */

export class Scan implements Constraint {
  constructor(public e:ScanField,
              public a:ScanField,
              public v:ScanField,
              public n:ScanField) {}

  protected resolved:ResolvedEAVN = {e: undefined, a: undefined, v:undefined, n: undefined};
  protected registers:Register[] = createArray();
  protected registerLookup:boolean[] = createArray();

  isInput:boolean = false;
  proposal:Proposal = {cardinality: 0, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), proposer: this};

  toString() {
    return `Scan(${printField(this.e)} ${printField(this.a)} ${printField(this.v)} ${printField(this.n)})`;
  }

  toKey() {
    let e = isRegister(this.e) ? `$reg(${this.e.offset})` : this.e;
    let a = isRegister(this.a) ? `$reg(${this.a.offset})` : this.a;
    let v = isRegister(this.v) ? `$reg(${this.v.offset})` : this.v;
    return `${e}|${a}|${v}`
  }

  /**
   * Resolve each scan field.
   * The resolved object may contain one of three possible value types:
   * - IGNORE_REG -- this field is entirely ignored by the scan.
   * - undefined -- this field is a register that hasn't been filled in yet.
   *                We'll fill it if possible.
   * - ID -- this field contains a static or already solved value.
   */
  resolve(prefix:Prefix) {
    let resolved = this.resolved;
    if(isRegister(this.e)) {
      resolved.e = prefix[this.e.offset];
    } else {
      resolved.e = this.e;
    }

    if(isRegister(this.a)) {
      resolved.a = prefix[this.a.offset];
    } else {
      resolved.a = this.a;
    }

    if(isRegister(this.v)) {
      resolved.v = prefix[this.v.offset];
    } else {
      resolved.v = this.v;
    }

    if(isRegister(this.n)) {
      resolved.n = prefix[this.n.offset];
    } else {
      resolved.n = this.n;
    }

    return resolved;
  }

  /**
   * A field is unresolved if it is completely ignored by the scan or
   * is an output of the scan.
   */
  fieldUnresolved(resolved:ResolvedEAVN, key: keyof ResolvedEAVN) {
    return resolved[key] === IGNORE_REG || resolved[key] === undefined;
  }

  /**
   * A field is not a static match if it is ignored, not a static
   * field, or the input value does not match the static value.
   */
  notStaticMatch(input:Change, key: "e"|"a"|"v"|"n") {
    return this[key] !== IGNORE_REG && !isRegister(this[key]) && this[key] !== input[key];
  }

  isAffected(input:Change):ApplyInputState {
    // If this change isn't relevant to this scan, skip it.
    if(this.notStaticMatch(input, "e")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "a")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "v")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "n")) return ApplyInputState.none;
    return ApplyInputState.pass;
  }

  /**
   * Apply new changes that may affect this scan to the prefix to
   * derive only the results affected by this change.  If the change
   * was successfully applied or irrelevant we'll return true. If the
   * change was relevant but invalid (i.e., this scan could not be
   * satisfied due to proposals from previous scans) we'll return
   * false.
   */
  applyInput(input:Change, prefix:Prefix):ApplyInputState {
    // For each register field of this scan:
    //   if the required value is impossible fail,
    //   else add this new value to the appropriate prefix register.
    // @NOTE: Technically, we republish existing values here too.
    //   In practice, that's harmless and eliminates the need for a branch.
    if(isRegister(this.e)) {
      if(prefix[this.e.offset] !== undefined && prefix[this.e.offset] !== input.e) return ApplyInputState.fail;
      prefix[this.e.offset] = input.e;
    }

    if(isRegister(this.a)) {
      if(prefix[this.a.offset] !== undefined && prefix[this.a.offset] !== input.a) return ApplyInputState.fail;
      prefix[this.a.offset] = input.a;
    }

    if(isRegister(this.v)) {
      if(prefix[this.v.offset] !== undefined && prefix[this.v.offset] !== input.v) return ApplyInputState.fail;
      prefix[this.v.offset] = input.v;
    }

    if(isRegister(this.n)) {
      if(prefix[this.n.offset] !== undefined && prefix[this.n.offset] !== input.n) return ApplyInputState.fail;
      prefix[this.n.offset] = input.n;
    }

    return ApplyInputState.pass;
  }

  propose(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:any[]):Proposal {
    let {index} = context;
    let {e,a,v,n} = this.resolve(prefix);
    this.proposal.skip = false;
    let proposal = index.propose(this.proposal, e, a, v, n, transaction, round);
    let {forRegisters, forFields} = proposal;

    forRegisters.clear();
    let field;
    while((field = forFields.next()) !== undefined) {
      forRegisters.push(this[field as EAVNField] as Register);
    }
    if(proposal.forFields.length === 0) proposal.skip = true;
    return proposal;
  }

  resolveProposal(context:EvaluationContext, prefix:Prefix, proposal:Proposal, transaction:number, round:number, results:any[]):ID[][] {
    let {index} = context;
    return index.resolveProposal(proposal);
  }

  accept(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, solvingFor:Register[]):boolean {
    // Before we start trying to accept, we check if we care about the
    // registers we are currently solving.
    let solving = false;
    for(let register of solvingFor) {
      if(this.registerLookup[register.offset]) {
        solving = true;
        break;
      }
    }
    // If we aren't looking at any of these registers, then we just
    // say we accept.
    if(!solving) return true;
    let {e,a,v,n} = this.resolve(prefix);
    return context.index.check(e, a, v, n, transaction, round);
  }

  acceptInput(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number):boolean {
    let {e,a,v,n} = this.resolve(prefix);
    if((e === IGNORE_REG || input.e === e) &&
       (a === IGNORE_REG || input.a === a) &&
       (v === IGNORE_REG || input.v === v) &&
       (n === IGNORE_REG || input.n === n)) {
      return true;
    } else {
      return this.accept(context, prefix, transaction, round, this.registers);
    }
  }

  setupRegister(field:EAVNField, parts:string[]) {
    let value = this[field];
    if(isRegister(value)) {
      this.registers.push(value);
      parts.push(`resolved.${field} = prefix[${value.offset}];`);
    } else {
      this.resolved[field] = value;
    }
  }

  setupIsAffected() {
    let fields:EAVNField[] = ["e", "a", "v", "n"];
    let parts:string[] = [];
    for(let field of fields) {
      let value = this[field];
      if(!isRegister(value) && value !== IGNORE_REG) {
        parts.push(`if(${value} !== change["${field}"]) return ${ApplyInputState.none};`)
      }
    }
    this.isAffected = new Function("change", parts.join("\n")) as (change:Change) => ApplyInputState;
  }

  setupApplyInput() {
    let fields:EAVNField[] = ["e", "a", "v", "n"];
    let parts:string[] = [];
    for(let field of fields) {
      let value = this[field];
      if(isRegister(value)) {
        parts.push(`if(prefix[${value.offset}] !== undefined && prefix[${value.offset}] !== input.${field}) return ${ApplyInputState.fail};
                    prefix[${value.offset}] = input.${field};`);

      }
    }
    parts.push(`return ${ApplyInputState.pass}`)
    this.applyInput = new Function("input", "prefix", parts.join("\n")) as (change:Change, prefix:Prefix) => ApplyInputState;
  }

  // We precompute the registers we're interested in for fast accepts.
  setup() {
    let parts = ["var resolved = this.resolved;"];
    this.setupRegister("e", parts);
    this.setupRegister("a", parts);
    this.setupRegister("v", parts);
    this.setupRegister("n", parts);
    parts.push("return resolved");
    this.resolve = new Function("prefix", parts.join("\n")) as (prefix:Prefix) => ResolvedEAVN;

    this.setupIsAffected();
    this.setupApplyInput();
    for(let register of this.registers) {
      this.registerLookup[register.offset] = true;
    }
  }

  getRegisters():Register[] {
    return this.registers;
  }

  getDiffs(context:EvaluationContext, prefix:Prefix):RoundArray {
    let {e,a,v,n} = this.resolve(prefix);
    return context.index.getDiffs(e,a,v,n);
  }

}

//------------------------------------------------------------------------
// Function constraint
//------------------------------------------------------------------------

export type ConstraintFieldMap = {[name:string]: ScanField};
export type ResolvedFields = {[fieldName:string]: ResolvedValue};

export class FunctionConstraint implements Constraint {
  static registered: {[name:string]: typeof FunctionConstraint} = {};
  static register(name:string, klass: typeof FunctionConstraint) {
    FunctionConstraint.registered[name] = klass;
  }

  static filter = false;
  static variadic = false;
  static argNames:string[];
  static returnNames:string[];
  static fetchInfo(name:string):typeof FunctionConstraint {
    let info = FunctionConstraint.registered[name];
    if(!info) throw new Error("No function info for: " + name);
    return info;
  }

  static create(name:string, fields:ConstraintFieldMap, restFields:(ID|Register)[] = createArray()):FunctionConstraint|undefined {
    let cur = FunctionConstraint.registered[name];
    if(!cur) {
      throw new Error(`No function named ${name} is registered.`);
    }

    if(restFields.length && !cur.variadic) {
      console.error(`The ${name} function is not variadic, so may not accept restFields.`);
      restFields = createArray();
    }

    let created = new cur(fields, restFields);
    return created;
  }

  constructor(public fields:ConstraintFieldMap, public restFields:(ID|Register)[]) {}

  name:string;
  args:{[name:string]: string};
  returns:{[name:string]: string};
  argNames:string[];
  returnNames:string[];
  apply: (this: FunctionConstraint, ... things: any[]) => undefined|(number|string)[]|(number|string)[][];
  estimate?:(context:EvaluationContext, prefix:Prefix, transaction:number, round:number) => number
  state?: any;
  multi:boolean = false;
  isInput:boolean = false;

  fieldNames:string[];
  proposal:Proposal = {cardinality:0, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), proposer: this};
  protected resolved:ResolvedFields = {};
  protected resolvedRest:(number|undefined)[] = createArray();
  protected registers:Register[] = createArray();
  protected registerLookup:boolean[] = createArray();
  protected applyInputs:(RawValue|RawValue[])[] = createArray();
  protected applyRestInputs:RawValue[] = createArray();

  toString() {
    let params = this.fieldNames.map((v) => v + ": " + printField(this.fields[v])).join(", ");
    let restParams = this.restFields.map(printField).join(", ");
    return `FunctionConstraint("${this.name}", ${params} ${restParams ? `, [${restParams}]` : ""})`;
  }

  // We precompute the registers we're interested in for fast accepts.
  setup() {
    this.fieldNames = Object.keys(this.fields);

    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field)) this.registers.push(field);
    }

    for(let field of this.restFields) {
      if(isRegister(field)) this.registers.push(field);
    }

    for(let register of this.registers) {
      this.registerLookup[register.offset] = true;
    }

    this.setupResolve();
    this.setupResolveRest();
  }

  setupResolve() {
    let {resolved} = this;
    let parts = ["var resolved = this.resolved;"];
    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field)) {
        parts.push(`resolved["${fieldName}"] = prefix[${field.offset}];`);
      } else {
        resolved[fieldName] = field;
      }
    }
    parts.push("return resolved");
    this.resolve = new Function("prefix", parts.join("\n")) as (prefix:Prefix) => ResolvedEAVN;
  }

  setupResolveRest() {
    let {resolvedRest} = this;
    let parts = ["var resolvedRest = this.resolvedRest;"];
    let ix = 0;
    for(let field of this.restFields) {
      if(isRegister(field)) {
        parts.push(`resolvedRest[${ix}] = prefix[${field.offset}]`);
      } else {
        resolvedRest[ix] = field;
      }
      ix++;
    }
    parts.push("return resolvedRest;");
    this.resolveRest = new Function("prefix", parts.join("\n")) as (prefix:Prefix) => number[];
  }

  getRegisters() {
    return this.registers;
  }

  /**
   * Similar to `Scan.resolve`, but resolving a map of the function's
   * fields rather than an EAVN.
   */
  resolve(prefix:Prefix) {
    let resolved = this.resolved;

    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field)) {
        resolved[fieldName] = prefix[field.offset];
      } else {
        resolved[fieldName] = field;
      }
    }

    return resolved;
  }

  /**
   * If a function is variadic, we need to resolve its rest fields as well.
   */
  resolveRest(prefix:Prefix) {
    let resolvedRest = this.resolvedRest;

    let ix = 0;
    for(let field of this.restFields) {
      if(isRegister(field)) {
        resolvedRest[ix] = prefix[field.offset];
      } else {
        resolvedRest[ix] = field;
      }
      ix++;
    }

    return resolvedRest;
  }

  // Function constraints have nothing to apply to the input, so they
  // always return ApplyInputState.none
  isAffected(input:Change):ApplyInputState { return ApplyInputState.none; }
  applyInput(input:Change, prefix:Prefix):ApplyInputState { return ApplyInputState.none; }

  propose(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:any[]):Proposal {
    let proposal = this.proposal;
    proposal.forRegisters.clear();
    let resolved = this.resolve(prefix);

    // If none of our returns are unbound
    // @NOTE: We don't need to worry about the filter case here, since he'll be
    let unresolvedOutput = false;
    for(let output of this.returnNames) {
      if(resolved[output] === undefined) {
        unresolvedOutput = true;
        let field = this.fields[output];
        if(isRegister(field)) {
          proposal.forRegisters.push(field);
        }
      }
    }
    if(!unresolvedOutput) {
      proposal.skip = true;
      return proposal;
    }

    // If any of our args aren't resolved yet, we can't compute results either.
    // @NOTE: This'll need to be touched up when we add optional support if they
    //   co-inhabit the args object.
    for(let input of this.argNames) {
      if(resolved[input] === undefined) {
        proposal.skip = true;
        return proposal;
      }
    }

    // Similarly, if we're variadic we need to check that all of our
    // variadic inputs bound to registers are resolved too.
    // @NOTE: We really need to bend over backwards at the moment to
    //   convince TS to check a static member of the current class...
    if((this.constructor as (typeof FunctionConstraint)).variadic) {
      let resolvedRest = this.resolveRest(prefix);
      for(let field of resolvedRest) {
        if(field === undefined) {
          proposal.skip = true;
          return proposal;
        }
      }
    }

    // Otherwise, we're ready to propose.
    proposal.skip = false;

    if(this.estimate) {
      // If the function provides a cardinality estimator, invoke that.
      proposal.cardinality = this.estimate(context, prefix, transaction, round);

    } else {
      // Otherwise, we'll just return 1 for now, since computing a
      // function is almost always cheaper than a scan.
      // @NOTE: If this is an issue, we can just behave like scans and
      //   compute ourselves here, caching the results.
      proposal.cardinality = 1;
    }

    return proposal;
  }

  /**
   * Pack the resolved register values for the functions argument
   * fields into an array.
   */
  packInputs(prefix:Prefix) {
    let resolved = this.resolve(prefix);
    let inputs = this.applyInputs;
    let argIx = 0;
    for(let argName of this.argNames) {
      // If we're asked to resolve the propoal we know that we've
      // proposed, and we'll only propose if these are resolved.
      inputs[argIx] = GlobalInterner.reverse(resolved[argName]!);
      argIx++;
    }

    // If we're variadic, we also need to pack our var-args up and
    // attach them as the last argument.
    if((this.constructor as (typeof FunctionConstraint)).variadic) {
      let resolvedRest = this.resolveRest(prefix);
      let restInputs = this.applyRestInputs;
      restInputs.length = 0;
      let ix = 0;
      for(let value of resolvedRest) {
        if(value !== undefined) {
          restInputs[ix] = GlobalInterner.reverse(value);
        }
        ix++;
      }

      inputs[argIx] = restInputs;
    }
    return inputs;
  }

  unpackOutputs(outputs:RawValue[]) {
    for(let ix = 0; ix < outputs.length; ix++) {
      // @NOTE: we'd like to use arenaIntern here, but because of intermediate values
      // that's not currently a possibility. We should revisit this if a practical solution
      // for arenas surfaces.
      outputs[ix] = GlobalInterner.intern(outputs[ix]);
    }
    return outputs as Prefix;
  }

  getResult(prefix:Prefix, outputs:ID[]) {
    // Finally, if we had results, we create the result prefixes and pass them along.
    let result = createArray("functionResult") as Prefix;
    let ix = 0;
    for(let returnName of this.returnNames) {
      let field = this.fields[returnName];
      if(isRegister(field) && !prefix[field.offset]) {
        result[ix] = outputs[ix];
      }
      ix++;
    }
    return result;
  }

  checkResult(prefix:Prefix, outputs:ID[]) {
    // Finally, we make sure every return register matches up with our outputs.
    // @NOTE: If we just use solvingFor then we don't know the offsets into the outputs array,
    // so we check everything...
    let ix = 0;
    for(let returnName of this.returnNames) {
      let field = this.fields[returnName];
      let value = isRegister(field) ? prefix[field.offset] : field;
      if(value !== outputs[ix]) {
        return false;
      }
      ix++;
    }
    return true;
  }

  resolveProposal(context:EvaluationContext, prefix:Prefix, proposal:Proposal, transaction:number, round:number, results:any[]):ID[][] {
    // First we build the args array to provide the apply function.
    let inputs = this.packInputs(prefix);

    // Then we actually apply it and then unpack the outputs.
    let computed = this.apply.apply(this, inputs);
    if(!computed) return results;
    if(!this.multi) {
      // If it's not a multi-returning function, it has a single result.
      let outputs = this.unpackOutputs(computed);
      let result = this.getResult(prefix, outputs);
      results.push(result);
    } else {
      for(let row of computed) {
        // Otherwise it has N results.
        let outputs = this.unpackOutputs(row);
        let result = this.getResult(prefix, outputs);
        results.push(result);
      }
    }

    return results;
  }

  accept(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, solvingFor:Register[]):boolean {
    // If none of the registers we're solving for intersect our inputs
    // or outputs, we're not relevant to the solution.
    let isRelevant = false;
    for(let register of solvingFor) {
      if(this.registerLookup[register.offset]) {
        isRelevant = true;
        break;
      }
    }
    if(!isRelevant) return true;

    // If we're missing a field, we can't verify our output yet so we preliminarily accept.
    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field) && prefix[field.offset] === undefined) return true;
    }

    // First we build the args array to provide the apply function.
    let inputs = this.packInputs(prefix);

    // Then we actually apply it and then unpack the outputs.
    let computed = this.apply.apply(this, inputs);
    if(!computed) return false;
    if(!this.multi) {
      // If it's not a multi-returning function we only need to check against the single result.
      let outputs = this.unpackOutputs(computed);
      return this.checkResult(prefix, outputs);
    } else {
      // Otherwise we match against any of the results.
      for(let row of computed) {
        let outputs = this.unpackOutputs(row);
        if(this.checkResult(prefix, outputs)) return true;
      }
      return false;
    }
  }

  acceptInput(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number):boolean {
    return this.accept(context, prefix, transaction, round, this.registers);
  }

  getDiffs(context:EvaluationContext, prefix:Prefix):RoundArray {
    return [];
  }
}

export interface FunctionSetup {
  name:string,
  variadic?: boolean,
  args:{[argName:string]: string},
  returns:{[argName:string]: string},
  apply:(this: FunctionConstraint, ... things: any[]) => undefined|(number|string)[]|(number|string)[][],
  estimate?:(index:Index, prefix:Prefix, transaction:number, round:number) => number,
  initialState?:any,
  multi?: true|false;
}
export interface SingleFunctionSetup extends FunctionSetup {
  apply:(this: FunctionConstraint, ... things: any[]) => undefined|(number|string)[],
  multi?: false
}
export interface MultiFunctionSetup extends FunctionSetup {
  apply:(this: FunctionConstraint, ... things: any[]) => undefined|(number|string)[][],
  multi?: true
}

function _makeFunction({name, variadic = false, args, returns, apply, estimate, initialState, multi = false}:FunctionSetup) {
  class NewFunctionConstraint extends FunctionConstraint {
    static variadic = variadic;
    static filter = Object.keys(returns).length === 0;
    static argNames = Object.keys(args);
    static returnNames = Object.keys(returns);
    name = name;
    args = args;
    argNames = Object.keys(args);
    returnNames = Object.keys(returns);
    returns = returns;
    apply = apply;
    state = initialState;
    multi = multi
  }
  FunctionConstraint.register(name, NewFunctionConstraint);
}

export function makeFunction(args:SingleFunctionSetup) {
  return _makeFunction(args);
}
export function makeMultiFunction(args:MultiFunctionSetup) {
  args.multi = true;
  return _makeFunction(args);
}

//------------------------------------------------------------------------
// Nodes
//------------------------------------------------------------------------

/**
 * Base class for nodes, the building blocks of blocks.
 */
export abstract class Node {
  static NodeID = 0;
  ID = Node.NodeID++;
  traceType:TraceNode;
  results = new Iterator<Prefix>();

  toBranchString():string {
    return this.toString();
  }

  /**
   * Evaluate the node in the context of the currently solved prefix,
   * returning a set of valid prefixes to continue the query as
   * results.
   */
  abstract exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean;
}

/**
 * The JoinNode implements generic join across multiple constraints.
 * Since our system is incremental, we need to do something slightly
 * fancier than we did in the previous runtime.  For each new change
 * that enters the system, we ask each of our constraints whether they
 * are capable of producing a new result. In the case where a single
 * constraint can, we presolve that constraint and then run the rest
 * normally, limited to only producing results that match the first
 * constraint. However, if multiple constraints might apply the input,
 * we need to run for each *combination* of heads. E.g.:
 *
 * Given a join node with constraints [A, B, C, and D], where A and D
 * can both apply the input, we must combine the results of the
 * following computations to get the full result set:
 *
 * Apply {A} -> Do {B, C, D}
 * Apply {A, D} -> Do {B, C}
 * Apply {D} -> Do {A, B, C}
 *
 * We calculate this using the power set in exec.
 *
 * We then apply each of these combinations by running a genericJoin
 * over the remaining unresolved registers.  We ask each un-applied
 * constraint to propose a register to be solved. If a constraint is
 * capable of resolving one, it returns the set of registers it can
 * resolve and an estimate of the result set's cardinality. Generic
 * Join chooses the cheapest proposal, which the winning constraint
 * then fully computes (or retrieves from cache and returns). Next it
 * asks each other constraint to accept or reject the proposal. If the
 * constraint doesn't apply to the solved registers, it accepts.  If
 * the solution contains results that match the output of the
 * constraint, it also accepts. Otherwise, it must reject the solution
 * and that particular run yields no results.
 */

export class JoinNode extends Node {
  traceType = TraceNode.Join;
  isStatic = false;
  dormant = false;
  registerLength = 0;
  registerLookup:boolean[];
  registerArrays:Register[][];
  proposedResultsArrays:ID[][];
  emptyProposal:Proposal = {cardinality: Infinity, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), skip: true, proposer: {} as Constraint};
  inputCount:Multiplicity;
  protected affectedConstraints = new Iterator<Constraint>();

  constructor(public constraints:Constraint[]) {
    super();
    // We need to find all the registers contained in our scans so that
    // we know how many rounds of Generic Join we need to do.
    let registerLength = 0;
    let registerLookup = [];
    let registers = createArray() as Register[][];
    let proposedResultsArrays = createArray() as ID[][];
    let hasOnlyMoves = true;
    let hasNoScans = true;
    let onlyStatic = true;
    for(let constraint of constraints) {
      constraint.setup();
      if(!(constraint instanceof MoveConstraint)) hasOnlyMoves = false;
      else if(!constraint.isStatic) onlyStatic = false;

      if(constraint instanceof Scan) hasNoScans = false;

      for(let register of constraint.getRegisters()) {
        if(!registerLookup[register.offset]) {
          registers.push(createArray() as Register[]);
          proposedResultsArrays.push(createArray() as Prefix);
          registerLookup[register.offset] = true;
          registerLength++;
        }
      }
    }

    if(hasOnlyMoves) {
      for(let constraint of constraints as MoveConstraint[]) {
        constraint.shouldApplyInput = true;
      }
      this.isStatic = onlyStatic;
    }

    if(hasNoScans) {
      this.exec = JoinNode.prototype.downStreamExec;
    }

    this.registerLookup = registerLookup;
    this.registerArrays = registers;
    this.registerLength = registerLength;
    this.proposedResultsArrays = proposedResultsArrays;
  }

  toString() {
    return "JoinNode([\n  " + this.constraints.map(toString).join("\n  ") + "\n])";
  }

  findAffectedConstraints(input:Change, prefix:Prefix):Iterator<Constraint> {
    // @TODO: Hoist me out.
    let affectedConstraints = this.affectedConstraints;
    affectedConstraints.clear();
    for(let ix = 0, len = this.constraints.length; ix < len; ix++) {
      let constraint = this.constraints[ix];
      let result = constraint.isAffected(input);

      if(result !== ApplyInputState.none) {
        affectedConstraints.push(constraint);
      }
    }

    return affectedConstraints;
  }

  applyCombination(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>) {
    // debug("        Join combo:", prefix.slice());
    let countOfSolved = 0;
    for(let ix = 0; ix < this.registerLookup.length; ix++) {
      if(!this.registerLookup[ix]) continue;
      if(prefix[ix] !== undefined) countOfSolved++;
    }
    let remainingToSolve = this.registerLength - countOfSolved;
    // context.tracer.tracker.blockTime("PresolveCheck");
    let valid = this.presolveCheck(context, input, prefix, transaction, round);
    // context.tracer.tracker.blockTimeEnd("PresolveCheck");
    // debug("        Join combo valid:", valid, remainingToSolve, countOfSolved, this.registerLength);
    if(!valid) {
      // do nothing
      return false;

    } else if(!remainingToSolve) {
      // if it is valid and there's nothing left to solve, then we've found
      // a full result and we should just continue
      this.prefixToResults(context, this.constraints, prefix, round, results);
      // debug("        Join combo result:", results);
      return true;

    } else {
      // debug("              GJ:", remainingToSolve, this.constraints);
      // For each node, find the new results that match the prefix.
      this.genericJoin(context, prefix, transaction, round, results, remainingToSolve);
      // context.tracer.tracker.blockTimeEnd("GenericJoin");
      return true;
    }
  }

  unapplyConstraint(constraint:Constraint, prefix:Prefix) {
    for(let register of constraint.getRegisters()) {
      prefix[register.offset] = undefined as any;
    }
  }

  presolveCheck(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number):boolean {
    let {constraints} = this;
    // window["counts"][window["active"]]++;

    for(let constraint of constraints) {
      let valid = constraint.acceptInput(context, input, prefix, transaction, round);
      if(!valid) {
        // debug("          INVALID:", constraint);
        return false;
      }
    }

    return true;
  }

  computeMultiplicities(context: EvaluationContext, results:Iterator<Prefix>, prefix:Prefix, currentRound:number, diffs: RoundArray[], diffIndex:number = -1) {
    if(diffIndex === -1) {
      prefix[prefix.length - 2] = currentRound;
      prefix[prefix.length - 1] = this.inputCount;
      this.computeMultiplicities(context, results, prefix, currentRound, diffs, diffIndex + 1);
      prefix[prefix.length - 2] = undefined as any;
      prefix[prefix.length - 1] = undefined as any;
    } else if(diffIndex === diffs.length) {
      let result = copyArray(prefix, "gjResultsArray");
      context.tracer.capturePrefix(result);
      //debug("          GJ -> ", result);
      results.push(result);
    } else {
      let startingRound = prefix[prefix.length - 2];
      let startingMultiplicity = prefix[prefix.length - 1];
      let rounds = diffs[diffIndex];
      let roundToMultiplicity:{[round:number]: number} = {};
      let maxRound = currentRound;
      let ix = 0;
      let currentRoundCount = 0;
      for(let round of rounds) {
        if(Math.abs(round) - 1 > currentRound) {
          break;
        }
        currentRoundCount += round > 0 ? 1 : -1;
        ix++;
      }
      if(currentRoundCount) {
        prefix[prefix.length - 2] = Math.max(currentRound, startingRound);
        prefix[prefix.length - 1] = startingMultiplicity * currentRoundCount;
        this.computeMultiplicities(context, results, prefix, currentRound, diffs, diffIndex + 1);
      }
      for(; ix < rounds.length; ix++) {
        let round = rounds[ix];
        let count = round > 0 ? 1 : -1;
        prefix[prefix.length - 2] = Math.max(Math.abs(round) - 1, startingRound);
        prefix[prefix.length - 1] = startingMultiplicity * count;
        this.computeMultiplicities(context, results, prefix, currentRound, diffs, diffIndex + 1);
      }
      prefix[prefix.length - 2] = startingRound;
      prefix[prefix.length - 1] = startingMultiplicity;
    }
    return results;
  }

  prefixToResults(context:EvaluationContext, constraints:Constraint[], prefix:Prefix, round:number, results:Iterator<Prefix>) {
    let diffs = [];
    for(let constraint of constraints) {
      if(constraint.isInput || !(constraint instanceof Scan)) continue;
      let cur = constraint.getDiffs(context, prefix);
      diffs.push(cur);
    }
    this.computeMultiplicities(context, results, prefix, round, diffs);
  }

  genericJoin(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, roundIx:number = this.registerLength):Iterator<Prefix> {
    let {constraints, emptyProposal} = this;
    let proposedResults = this.proposedResultsArrays[roundIx - 1];
    let forRegisters:Register[] = this.registerArrays[roundIx - 1];
    proposedResults.length = 0;

    let bestProposal:Proposal = emptyProposal;

    for(let constraint of constraints) {
      let current = constraint.propose(context, prefix, transaction, round, proposedResults);
      if(!current.skip && current.cardinality === 0) {
        return results;
      } else if(current.cardinality < bestProposal.cardinality && !current.skip) {
        bestProposal = current;
      }
    }

    if(bestProposal.skip) {
      // debug("             BAILING", bestProposal);
      return results;
    }


    let {proposer} = bestProposal;
    // We have to copy here because we need to keep a reference to this even if later
    // rounds might overwrite the proposal
    moveArray(bestProposal.forRegisters.array, forRegisters);
    let resolved:any[] = proposer.resolveProposal(context, prefix, bestProposal, transaction, round, proposedResults);
    if(resolved[0] && resolved[0].constructor === Array) {
      resultLoop: for(let result of resolved) {
        let ix = 0;
        for(let register of forRegisters) {
          prefix[register.offset] = +result[ix];
          ix++;
        }
        for(let constraint of constraints) {
          if(constraint === proposer) continue;
          if(!constraint.accept(context, prefix, transaction, round, forRegisters)) {
            // debug("             BAILING", printConstraint(constraint));
            continue resultLoop;
          }
        }
        if(roundIx === 1) {
          this.prefixToResults(context, constraints, prefix, round, results);
        } else {
          this.genericJoin(context, prefix, transaction, round, results, roundIx - 1);
        }
      }
    } else {
      let register = forRegisters[0];
      resultLoop: for(let result of resolved) {
        prefix[register.offset] = +result as ID;
        for(let constraint of constraints) {
          if(constraint === proposer) continue;
          if(!constraint.accept(context, prefix, transaction, round, forRegisters)) {
            // debug("             BAILING", printConstraint(constraint));
            continue resultLoop;
          }
        }
        if(roundIx === 1) {
          this.prefixToResults(context, constraints, prefix, round, results);
        } else {
          this.genericJoin(context, prefix, transaction, round, results, roundIx - 1);
        }
      }
    }
    for(let register of forRegisters) {
      // @NOTE: marking this as any is spoopy at best, but since we should never
      // iterate over the prefix, but instead use it almost like a hash, this
      // should be fine.
      prefix[register.offset] = undefined as any;
    }

    return results;
  }

  downStreamExec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>) {
    if(this.isStatic && this.dormant) return false;

    this.inputCount = prefix[prefix.length - 1] !== undefined ? prefix[prefix.length - 1] : input.count;
    let inputRound = prefix[prefix.length - 2] !== undefined ? prefix[prefix.length - 2] : input.round;
    let didSomething = this.applyCombination(context, input, prefix, transaction, inputRound, results);

    if(this.isStatic && didSomething) {
      this.dormant = true;
    }
    return didSomething;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):boolean {
    let didSomething = false;
    this.inputCount = input.count;

    // if we are removing the block, we need the join to compute all the results currently
    // being generated by this block and undo them. We do this by sending a blank prefix
    // through with an input count of -1.
    if(input === BLOCK_REMOVE) {
      didSomething = this.applyCombination(context, input, prefix, transaction, round, results);
    } else if(this.isStatic && this.dormant) {
      return false;
    } else if(input === BLOCK_ADD) {
      didSomething = this.applyCombination(context, input, prefix, transaction, round, results);
    } else {
      this.inputCount = input.count;
      let affectedConstraints = this.findAffectedConstraints(input, prefix);

      let combinationCount = Math.pow(2, affectedConstraints.length);
      for(let comboIx = combinationCount - 1; comboIx > 0; comboIx--) {
        //console.log("  Combo:", comboIx);

        let shouldApply = true;

        for(let constraintIx = 0; constraintIx < affectedConstraints.length; constraintIx++) {
          let mask = 1 << constraintIx;
          let isIncluded = (comboIx & mask) !== 0;
          let constraint = affectedConstraints.array[constraintIx];
          constraint.isInput = isIncluded;

          if(isIncluded) {
            let valid = constraint.applyInput(input, prefix);
            // debug("        included", printConstraint(constraint));
            // If any member of the input constraints fails, this whole combination is doomed.
            if(valid === ApplyInputState.fail) {
              shouldApply = false;
              break;
            }
            //console.log("    " + printConstraint(constraint));
          }
        }

        //console.log("    ", printPrefix(prefix));
        if(shouldApply) {
          didSomething = this.applyCombination(context, input, prefix, transaction, round, results) || didSomething;
        }

        let constraint;
        affectedConstraints.reset();
        while((constraint = affectedConstraints.next()) !== undefined) {
          this.unapplyConstraint(constraint, prefix);
        }
      }

      affectedConstraints.reset();
      let constraint;
      while((constraint = affectedConstraints.next()) !== undefined) {
        constraint.isInput = false;
      }
    }

    if(this.isStatic && didSomething) {
      this.dormant = true;
    }

    return didSomething;
  }
}

export class DownstreamJoinNode extends JoinNode {
  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):boolean {
    return this.downStreamExec(context, input, prefix, transaction, round, results);
  }
}

export class NoopJoinNode extends JoinNode {
  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):boolean {
    if(!this.dormant) {
      this.prefixToResults(context, this.constraints, prefix, round, results);
      this.dormant = true;
      return true
    }
    return false;
  }
}

export class WatchNode extends Node {
  traceType = TraceNode.Watch;
  constructor(public e:ID|Register,
              public a:ID|Register,
              public v:ID|Register,
              public n:ID|Register,
              public blockId:number) {
                super();
  }

  protected resolved:ResolvedFields = {};
  resolve = Scan.prototype.resolve;

  toString() {
    return `WatchNode(${printField(this.e)}, ${printField(this.a)}, ${printField(this.v)}, ${printField(this.n)})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, results:Iterator<Prefix>, transaction:Transaction):boolean {
    let resolved = this.resolve(prefix);
    let {e,a,v,n} = resolved;

    // @NOTE: This is wasteful.
    results.push(prefix);

    if(e === undefined || a === undefined || v === undefined || n === undefined) {
      throw new Error(`Unable to produce an output with an undefined EAVN field [${e}, ${a}, ${v}, ${n}]`);
    }

    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];

    // @FIXME: Make sure I still work now that I'm sending all my deltas. I think I still need to use local intermediates.
    let change = new Change(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount);
    transaction.export(context, this.blockId, change);
    return true;
  }
}

export class OutputWrapperNode extends Node {
  traceType = TraceNode.Output;
  constructor(public nodes:OutputNode[]) {
    super();
  }

  toString() {
    return `OutputWrapper([${this.nodes.length ? "\n  " : ""}${indent(this.nodes.map(toString).join("\n"), 2)}])`;
  }

  binds = new Iterator<Change>();
  commits = new Iterator<Change>();

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, results:Iterator<Prefix>, transaction:Transaction):boolean {
    let {tracer} = context;
    let {binds, commits} = this;
    binds.clear();
    commits.clear();
    for(let node of this.nodes) {
      node.exec(context, input, prefix, transactionId, round, binds, commits);
    }

    binds.reset();
    let change;
    while(change = binds.next()) {
      transaction.output(context, change);
    }

    commits.reset();
    while(change = commits.next()) {
      transaction.commit(context, change);
    }

    return true;
  }
}

export interface OutputNode {
  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, binds:Iterator<Change>, commits:Iterator<Change>):void;
}

export class InsertNode implements OutputNode {
  multiplier:number = 1;
  resolve: (prefix:Prefix) => ResolvedEAVN;

  constructor(public e:ID|Register, public a:ID|Register, public v:ID|Register, public n:ID|Register) {
    let parts = ["var resolved = this.resolved;"];
    this.setupRegister("e", parts);
    this.setupRegister("a", parts);
    this.setupRegister("v", parts);
    this.setupRegister("n", parts);
    parts.push("return resolved");
    this.resolve = new Function("prefix", parts.join("\n")) as (prefix:Prefix) => ResolvedEAVN;
  }

  toString() {
    return `InsertNode(${printField(this.e)}, ${printField(this.a)}, ${printField(this.v)}, ${printField(this.n)})`;
  }

  setupRegister(field:EAVNField, parts:string[]) {
    let value = this[field];
    if(isRegister(value)) {
      parts.push(`resolved.${field} = prefix[this.${field}.offset];`);
    } else {
      this.resolved[field] = value;
    }
  }

  // We precompute the registers we're interested in for fast accepts.
  protected resolved:ResolvedEAVN = {e: undefined, a: undefined, v:undefined, n: undefined};

  output(change:Change, binds:Iterator<Change>, commits:Iterator<Change>) {
    binds.push(change);
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, binds:Iterator<Change>, commits:Iterator<Change>):boolean {
    let resolved = this.resolve(prefix);
    let {e,a,v,n} = resolved;

    if(e === undefined || a === undefined || v === undefined || n === undefined) {
      throw new Error(`Unable to produce an output with an undefined EAVN field [${e}, ${a}, ${v}, ${n}]`);
    }

    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];

    let change = new Change(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount * this.multiplier);
    this.output(change, binds, commits);
    return true;
  }
}

export class CommitInsertNode extends InsertNode {
  toString() {
    return `CommitInsertNode(${printField(this.e)}, ${printField(this.a)}, ${printField(this.v)}, ${printField(this.n)})`;
  }

  output(change:Change, binds:Iterator<Change>, commits:Iterator<Change>) {
    commits.push(change);
  }
}

export class RemoveNode extends InsertNode {
  multiplier:number = -1;

  toString() {
    return `RemoveNode(${printField(this.e)}, ${printField(this.a)}, ${printField(this.v)}, ${printField(this.n)})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, binds:Iterator<Change>, commits:Iterator<Change>):boolean {
    let resolved = this.resolve(prefix);
    let {e,a,v,n} = resolved;

    if(e === undefined || a === undefined || (v === undefined && this.v !== IGNORE_REG) || n === undefined) {
      return false;
    }

    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];

    if(this.v !== IGNORE_REG) {
      let change = new RemoveChange(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount * this.multiplier);
      this.output(change, binds, commits);
    } else if(this.a !== IGNORE_REG) {
      let change = new RemoveVsChange(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount * this.multiplier);
      this.output(change, binds, commits);
    } else {
      let change = new RemoveAVsChange(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount * this.multiplier);
      this.output(change, binds, commits);
    }
    return true;
  }
}

export class CommitRemoveNode extends CommitInsertNode {
  toString() {
    return `CommitRemoveNode(${printField(this.e)}, ${printField(this.a)}, ${printField(this.v)}, ${printField(this.n)})`;
  }

  multiplier = -1;

  protected _exec = RemoveNode.prototype.exec;

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transactionId:number, round:number, binds:Iterator<Change>, commits:Iterator<Change>):boolean {
    return this._exec(context, input, prefix, transactionId, round, binds, commits);
  }
}

//------------------------------------------------------------------------------
// LinearFlow
//------------------------------------------------------------------------------

export class LinearFlow extends Node {
  traceType = TraceNode.LinearFlow;
  results = new Iterator<Prefix>();
  initialResults = new Iterator<Prefix>();

  constructor(public nodes:Node[]) {
    super();
  }

  toString() {
    let content = this.nodes.map(toString).join(",\n");
    return `LinearFlow([\n  ${indent(content, 2)}\n])`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    this.initialResults.clear();
    this.initialResults.push(prefix);
    // We populate the prefix with values from the input change so we only derive the
    // results affected by it.
    let curPrefix;
    let iter = this.initialResults;
    for(let node of this.nodes) {
      if(iter.length === 0) return false;
      node.results.clear();
      while(curPrefix = iter.next()) {
        context.tracer.node(node, curPrefix);
        let valid = node.exec(context, input, curPrefix, transaction, round, node.results, changes);
        context.tracer.pop(TraceFrameType.Node);
      }
      iter = node.results.iter();
    }

    while(curPrefix = iter.next()) {
      results.push(curPrefix);
    }

    return true;
  }
}

//------------------------------------------------------------------------------
// BinaryFlow
//------------------------------------------------------------------------------

export type KeyFunction = (prefix:Prefix) => string;

export class IntermediateIndexIterator {
  values:{[value:string]: any[]};
  valueKeys:string[];
  currentCounts: any[];

  valueIx = 0;
  countIx = 0;

  round = 0;
  count = 0;
  minRound = 0;

  reset(values:{[value:string]: any[]}, minRound = 0) {
    this.values = values;
    this.valueIx = 0;
    this.countIx = 0;
    this.round = 0;
    this.count = 0;
    this.minRound = minRound + 1;
    this.valueKeys = Object.keys(values);
    this.currentCounts = values[this.valueKeys[0]];
    return this;
  }

  next():Prefix|undefined {
    let {currentCounts, countIx, minRound} = this;
    if(!currentCounts) return;
    countIx++;
    if(countIx >= currentCounts.length) {
      this.valueIx++;
      let nextValue = this.valueKeys[this.valueIx];
      currentCounts = this.currentCounts = this.values[nextValue];
      if(!currentCounts) return;
      countIx = 1;
    }
    let count = 0;
    if(countIx < minRound) {
      let total = 0;
      for(; countIx <= minRound; countIx++) {
        let cur = currentCounts[countIx];
        if(!cur) continue;
        total += cur;
      }
      count = total;
      countIx = minRound;
    } else {
      for(; countIx < currentCounts.length; countIx++) {
        let cur = currentCounts[countIx];
        if(cur) {
          count = cur;
          break;
        }
      }
    }
    this.round = countIx - 1;
    this.count = count;
    this.countIx = countIx;
    if(count == 0) return this.next();
    return currentCounts[0];
  }
}

export class IntermediateIndex {
  static CreateKeyFunction(registers:Register[]):KeyFunction {
    let items = registers.map((reg) => {
      return `prefix[${reg.offset}]`;
    })
    let code = `
      return "" ${items.length ? "+" : ""} ${items.join(' + "|" + ')};
      `;
    return new Function("prefix", code) as KeyFunction;
  }

  index:{[key:string]: {[value:string]: any[]}} = {};
  iterator = new IntermediateIndexIterator();

  insert(key:string, prefix:Prefix) {
    let values = this.index[key];
    if(!values) values = this.index[key] = createHash("intermediateIndexValues");
    let valueKey = this.hashPrefix(prefix);
    let counts = values[valueKey];
    if(!counts) {
      counts = values[valueKey] = createArray("intermediateIndexCounts");
      counts[0] = prefix;
    }
    let round = prefix[prefix.length - 2] + 1;
    let count = prefix[prefix.length - 1];
    counts[round] = count + (counts[round] || 0);
    if(!counts[round]) {
      let shouldRemove = true;
      for(let ix = 1, len = counts.length; ix < len; ix++) {
        if(counts[ix]) {
          shouldRemove = false;
          break;
        }
      }
      if(shouldRemove) {
        delete values[valueKey];
      }
    }
  }

  iter(key:string, round:number):IntermediateIndexIterator|undefined {
    let values = this.index[key];
    if(values) return this.iterator.reset(values, round);
  }

  hashPrefix(prefix:Prefix) {
    let round = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    prefix[prefix.length - 2] = undefined as any;
    prefix[prefix.length - 1] = undefined as any;
    let key = prefix.join("|");
    prefix[prefix.length - 2] = round;
    prefix[prefix.length - 1] = count;
    return key;
  }
}

export class ZeroingIterator {
  counts:Multiplicity[];
  roundIx = -1;
  countSum = 0;
  minRound = 0;
  count = 1;

  reset(counts:Multiplicity[], minRound:number = 0) {
    this.counts = counts;
    this.minRound = minRound;
    this.roundIx = -1;
    this.countSum = 0;
    this.count = 1;
    return this;
  }

  next():number|undefined {
    let {roundIx, counts, countSum, minRound} = this;
    let countsLength = counts.length;
    roundIx++;
    if(roundIx >= countsLength) return;
    let final;
    if(roundIx <= minRound) {
      if(minRound >= countsLength) countsLength = minRound + 1;
      for(; roundIx < countsLength; roundIx++) {
        let cur = counts[roundIx];
        if(cur) {
          countSum += cur;
        }
        if(roundIx >= minRound && countSum === 0) {
          final = roundIx;
          break;
        }
      }
    } else {
      for(; roundIx <= countsLength; roundIx++) {
        let cur = counts[roundIx];
        if(!cur) continue;
        countSum += cur;
        if((this.countSum === 0 && countSum > 0) ||
           (this.countSum > 0 && countSum === 0)) {
          final = roundIx;
          break;
        }
      }
    }

    this.roundIx = roundIx;
    this.countSum = countSum;
    this.count = 1;
    if(countSum !== 0) {
      this.count = -1;
    }
    return final;
  }
}

export class KeyOnlyIntermediateIndex {
  index:{[key:string]: Multiplicity[]} = {};
  iterator = new ZeroingIterator();

  insert(key:string, prefix:Prefix) {
    let counts = this.index[key];
    if(!counts) counts = this.index[key] = createArray("KeyOnlyIntermediateIndex");
    let round = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    let prev = counts[round] || 0;
    counts[round] = count + prev;
    if(!counts[round]) {
      let shouldRemove = true;
      for(let ix = 0, len = counts.length; ix < len; ix++) {
        if(counts[ix]) {
          shouldRemove = false;
          break;
        }
      }
      if(shouldRemove) {
        delete this.index[key];
      }
    }
  }

  has(key:string) {
    return this.index[key] ? true : false;
  }

  iter(key:string, round:number):ZeroingIterator|undefined {
    let values = this.index[key];
    if(values) return this.iterator.reset(values, round);
  }
}

export abstract class BinaryFlow extends Node {
  traceType = TraceNode.BinaryJoin;

  constructor(public left:Node, public right:Node) {
    super();
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let {left, right} = this;
    left.results.clear();
    context.tracer.node(left, prefix);
    left.exec(context, input, prefix, transaction, round, left.results, changes);
    context.tracer.pop(TraceFrameType.Node);
    right.results.clear();
    context.tracer.node(right, prefix);
    right.exec(context, input, prefix, transaction, round, right.results, changes);
    context.tracer.pop(TraceFrameType.Node);
    let result;
    let leftResults = left.results.iter();
    let rightResults = right.results.iter();
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(context, result, transaction, round, results);
    }
    while((result = rightResults.next()) !== undefined) {
      this.onRight(context, result, transaction, round, results);
    }
    return true;
  }

  abstract onLeft(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void;
  abstract onRight(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void;
}

export class BinaryJoinRight extends BinaryFlow {
  leftIndex = new IntermediateIndex();
  rightIndex = new IntermediateIndex();
  keyFunc:KeyFunction;

  constructor(public left:Node, public right:Node, public keyRegisters:Register[], public registersToMerge:Register[]) {
    super(left, right);
    this.keyFunc = IntermediateIndex.CreateKeyFunction(keyRegisters);
  }

  _nodeName:string = "BinaryJoinRight";

  toString() {
    let keys = "[" + this.keyRegisters.map((r) => `[${r.offset}]`).join(", ") + "]";
    let merge = "[" + this.registersToMerge.map((r) => `[${r.offset}]`).join(", ") + "]";
    return `${this._nodeName}({
  keys: ${keys},
  merge: ${merge},
  left: ${indent(toString(this.left), 2)},
  right: ${indent(toString(this.right), 2)}
})`;
  }
  toBranchString() {
    let keys = "[" + this.keyRegisters.map((r) => `[${r.offset}]`).join(", ") + "]";
    let merge = "[" + this.registersToMerge.map((r) => `[${r.offset}]`).join(", ") + "]";

    return `${this._nodeName}({
  keys: ${keys},
  merge: ${merge},
  right: ${indent(toString(this.right), 2)}
})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    // debug("    Binary Join Right:")
    let {left, right} = this;
    right.results.clear();
    context.tracer.node(right, prefix);
    right.exec(context, input, prefix, transaction, round, right.results, changes);
    context.tracer.pop(TraceFrameType.Node);
    let leftResults = left.results.iter();
    let rightResults = right.results.iter();
    let result;
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(context, result, transaction, round, results);
    }
    while((result = rightResults.next()) !== undefined) {
      this.onRight(context, result, transaction, round, results);
    }
    // debug("        results:", results.array.slice());
    return true;
  }

  merge(left:Prefix, right:Prefix) {
    for(let register of this.registersToMerge) {
      let leftValue = left[register.offset];
      let rightValue = right[register.offset];
      if(leftValue === undefined || leftValue === rightValue) {
        left[register.offset] = rightValue
      } else {
        return false;
      }
    }
    return true;
  }

  onLeft(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    this.leftIndex.insert(key, prefix);
    let diffs = this.rightIndex.iter(key, round)
    // debug("       join left", key, printPrefix(prefix), diffs);
    if(!diffs) return;
    let rightPrefix;
    while(rightPrefix = diffs.next()) {
      let result = copyArray(prefix, "BinaryJoinResult");
      if(this.merge(result, rightPrefix)) {
        result[result.length - 2] = Math.max(prefixRound, diffs.round);
        result[result.length - 1] = count * diffs.count;
        context.tracer.capturePrefix(result);
        results.push(result);
        // debug("               join left -> ", printPrefix(result), diffs.round, count, diffs.count);
      }
    }
  }

  onRight(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    this.rightIndex.insert(key, prefix);
    let diffs = this.leftIndex.iter(key, round)
    // debug("       join right", key, this.rightIndex.index[key]);
    if(!diffs) return;
    let leftPrefix;
    while(leftPrefix = diffs.next()) {
      let result = copyArray(leftPrefix, "BinaryJoinResult");
      if(this.merge(result, prefix)) {
        result[result.length - 2] = Math.max(prefixRound, diffs.round);
        result[result.length - 1] = count * diffs.count;
        context.tracer.capturePrefix(result);
        results.push(result);
        // debug("              join right -> ", printPrefix(result.slice()), diffs.round, count, diffs.count);
      }
    }
  }
}

export class AntiJoin extends BinaryFlow {
  traceType = TraceNode.AntiJoin;
  leftIndex = new IntermediateIndex();
  rightIndex = new KeyOnlyIntermediateIndex();
  distinct = new DistinctIndex();
  keyFunc:KeyFunction;

  constructor(public left:Node, public right:Node, public keyRegisters:Register[]) {
    super(left, right);
    this.keyFunc = IntermediateIndex.CreateKeyFunction(keyRegisters);
  }

  toString() {
    let left = indent(toString(this.left), 2);
    let right = indent(toString(this.right), 2);
    return `Antijoin({\n  left: ${left},\n  right: ${right}\n})`;
  }
  toBranchString() {
    let right = indent(toString(this.right), 2);
    return `Antijoin({\n  right: ${right}\n})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    // debug("            antijoin:")
    return super.exec(context,input,prefix,transaction,round,results,changes);
  }

  onLeft(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    this.leftIndex.insert(key, prefix);
    let diffs = this.rightIndex.iter(key, prefixRound);
    // debug("                left:", key, count, this.rightIndex.index[key] && copyArray(this.rightIndex.index[key]), prefix);
    if(!diffs) {
      // debug("                    left ->", key, count, diffs)
      return results.push(prefix);
    } else {
      let currentRound;
      while((currentRound = diffs.next()) !== undefined) {
        let result = copyArray(prefix, "AntiJoinResult");
        result[result.length - 2] = currentRound;
        result[result.length - 1] = diffs.count * count;
        context.tracer.capturePrefix(result);
        results.push(result);
        // debug("                    left ->", key, count, currentRound, result[result.length - 1])
      }
    }
  }

  onRight(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let count = prefix[prefix.length - 1];
    this.rightIndex.insert(key, prefix);
    let neue = new Iterator<[number, number]>();
    this.distinct.distinctKey(key, prefixRound, count, neue)
    let diffs = this.leftIndex.iter(key, prefixRound)
    let copy = (thing:any) => {
      let neue = copyHash(thing);
      for(let key in thing) {
        neue[key] = thing[key].slice();
      }
      return neue;
    }
    // debug("                right:", key, count, this.leftIndex.index[key] && copy(this.leftIndex.index[key]));
    // debug("                right distinct: ", this.distinct.index[key], neue);
    if(!diffs || !neue.length) return;
    let leftPrefix;
    let rightDelta;
    while(rightDelta = neue.next()) {
      let [rightRound, rightCount] = rightDelta;
      diffs = this.leftIndex.iter(key, prefixRound)!; // We already checked for this above.
      while(leftPrefix = diffs.next()) {
        let result = copyArray(leftPrefix, "AntiJoinResult");
        let maxRound = Math.max(diffs.round, rightRound);
        result[result.length - 2] = maxRound;
        result[result.length - 1] = rightCount * diffs.count * -1;
        context.tracer.capturePrefix(result);
        results.push(result);
        // debug("                    right ->", key, maxRound, rightCount, diffs.count, result[result.length - 1])
      }
    }
  }
}

export class AntiJoinPresolvedRight extends AntiJoin {
  toString() {
    return `AntiJoinPresolvedRight(${toString(this.left)})`;
  }
  toBranchString() {
    return `AntiJoinPresolvedRight(${this.left.toBranchString()})`;
  }

  traceType = TraceNode.AntiJoinPresolvedRight;
  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let {left, right} = this;
    left.results.clear();
    context.tracer.node(left, prefix);
    left.exec(context, input, prefix, transaction, round, left.results, changes);
    context.tracer.pop(TraceFrameType.Node);
    let leftResults = left.results.iter();
    let rightResults = right.results.iter();
    let result;
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(context, result, transaction, round, results);
    }
    while((result = rightResults.next()) !== undefined) {
      this.onRight(context, result, transaction, round, results);
    }
    return true;
  }
}

export class UnionFlow extends Node {
  traceType = TraceNode.Union;
  branches:BinaryJoinRight[] = [];
  emptyResults = new Iterator<Prefix>();

  constructor(public left:Node, branches:Node[], public keyRegisters:Register[][], public registersToMerge:Register[], public extraOuterJoins:Register[]) {
    super();
    let ix = 0;
    for(let branch of branches) {
      this.branches.push(new BinaryJoinRight(left, branch, keyRegisters[ix].concat(extraOuterJoins), registersToMerge));
      ix++;
    }
  }

  toString() {
    let name;
    let branchText = (this.branches as Node[]).map((branch) => indent(branch.toBranchString(), 4)).join(",\n    ");
    return `UnionFlow({
  left: ${indent(toString(this.left), 2)},
  branches: [\n    ${branchText}\n)}]
})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let {left} = this;
    let {tracer} = context;
    let tempLeftResults = left.results;

    left.results.clear();
    tracer.node(left, prefix);
    left.exec(context, input, prefix, transaction, round, left.results, changes);
    tracer.pop(TraceFrameType.Node);

    let leftPrefix;
    let leftResults = left.results.iter();
    for(let node of this.branches) {
      node.results.clear();

      tracer.node(node, prefix);
      node.exec(context, input, prefix, transaction, round, node.results, changes);
      tracer.pop(TraceFrameType.Node);

      // Because we've already run this node once, we don't want it to potentially see the left's
      // results multiple times. As such, we temporarily set the results to an empty iterator
      // so that downstream nodes see nothing and we set it back once we've gone through
      // all the left prefixes.
      left.results = this.emptyResults;
      leftResults.reset();
      if(node.keyRegisters.length && input !== BLOCK_ADD && input !== BLOCK_REMOVE) {
        while((leftPrefix = leftResults.next()) !== undefined) {
          tracer.node(node, leftPrefix);
          node.exec(context, input, copyArray(leftPrefix, "UnionLeftPrefixCopy"), transaction, round, node.results, changes);
          tracer.pop(TraceFrameType.Node);
        }
      }
      // set the left results back to the real results
      left.results = tempLeftResults;

      let branchResults = node.results.iter();
      let result;
      while((result = branchResults.next())) {
        results.push(result);
      }

    }
    return true;
  }
}

export class ChooseFlow extends Node {
  traceType = TraceNode.Choose;
  leftResults = new Iterator<Prefix>();
  emptyResults = new Iterator<Prefix>();
  branches:(BinaryJoinRight|AntiJoinPresolvedRight)[] = [];

  constructor(public left:Node, initialBranches:Node[], public keyRegisters:Register[][], public registersToMerge:Register[], public extraOuterJoins:Register[]) {
    super();
    let allKeys:Register[] = []
    for(let keySet of keyRegisters) {
      for(let key of keySet) {
        if(!allKeys.some((r) => r.offset === key.offset)) {
          allKeys.push(key);
        }
      }
    }
    let {branches} = this;
    let prev:Node|undefined;
    let ix = 0;
    for(let branch of initialBranches) {
      let myKeys = keyRegisters[ix].concat(extraOuterJoins);
      let join;
      if(prev) {
        join = new BinaryJoinRight(left, branch, myKeys, registersToMerge);
        let antijoin = new AntiJoinPresolvedRight(join, this, allKeys);
        branches.push(antijoin);
      } else {
        join = new BinaryJoinRight(left, branch, myKeys, registersToMerge);
        branches.push(join);
      }
      prev = join;
      ix++;
    }
  }

  toString() {
    let name;
    let branchText = (this.branches as Node[]).map((branch) => indent(branch.toBranchString(), 4)).join(",\n    ");
    return `ChooseFlow({
  left: ${indent(toString(this.left), 2)},
  branches: [\n    ${branchText}\n)}]
})`;
  }


  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let {tracer} = context;
    let {branches, left} = this;
    let prev:Iterator<Prefix>|undefined;
    let ix = 0;
    let tempResults = this.results;
    let tempLeftResults = left.results;

    left.results.clear();
    tracer.node(left, prefix);
    left.exec(context, input, prefix, transaction, round, left.results, changes);
    tracer.pop(TraceFrameType.Node);

    let leftResults = left.results.iter();
    let leftPrefix;

    for(let node of branches) {

      node.results.clear();
      tracer.node(node, prefix);
      node.exec(context, input, prefix, transaction, round, node.results, changes);
      tracer.pop(TraceFrameType.Node);

      // Because we've already run this node once, we don't want it to potentially see our
      // results multiple times. As such, we temporarily set our results to an empty iterator
      // so that downstream nodes see nothing and we set it back once we've gone through
      // all the left prefixes. This ensures that AntiJoinPresolvedRight only sees the previous
      // branches' results once. We also need to do this for our left's results, since we'll have
      // seen those as well and would otherwise double count them.
      this.results = this.emptyResults;
      left.results = this.emptyResults;
      leftResults.reset();
      if(node.keyRegisters.length && input !== BLOCK_ADD && input !== BLOCK_REMOVE) {
        while((leftPrefix = leftResults.next()) !== undefined) {
          tracer.node(node, leftPrefix);
          node.exec(context, input, copyArray(leftPrefix, "ChooseLeftPrefixCopy"), transaction, round, node.results, changes);
          tracer.pop(TraceFrameType.Node);
        }
      }
      // per above, make sure we set our results back to the real iterator
      this.results = tempResults;
      left.results = tempLeftResults;
      let branchResult = node.results.iter();
      let result;
      while((result = branchResult.next()) !== undefined) {
        tracer.capturePrefix(result);
        results.push(result);
      }
    }
    return true;
  }
}

export class MergeAggregateFlow extends BinaryJoinRight {
  _nodeName:string = "MergeAggregateFlow";

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    // debug("        AGG MERGE");
    let result;
    let {left, right} = this;
    left.results.clear();
    left.exec(context, input, prefix, transaction, round, left.results, changes);
    // debug("              left results: ", leftResults);

    let leftResults = left.results.iter();
    // we run the left's results through the aggregate to capture all the aggregate updates
    right.results.clear();
    while((result = leftResults.next()) !== undefined) {
      // debug("              left result: ", result.slice());
      right.exec(context, input, result, transaction, round, right.results, changes);
    }

    // now we go through all the lefts and rights like normal
    leftResults.reset();
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(context, result, transaction, round, results);
    }
    let rightResults = right.results.iter();
    while((result = rightResults.next()) !== undefined) {
      this.onRight(context, result, transaction, round, results);
    }
    return true;
  }
}

// This node is a bit strange, but is required to make sure that aggregates
// that are inside of a choose don't end up seeing results that wouldn't actually
// join with the outer scope of the choose. For example if we have the following rule:
//
// prog.block("count the names of people", ({find, gather, record, choose}) => {
//   let person = find("person");
//   let [sort] = choose(() => {
//     return gather(person.name).count();
//   }, () => "yo yo yo");
//   return [person.add("next", sort)];
// });
//
// If we join the choose branch to the outer *after* we've aggregated, then we're
// going to count everything with a name whether they're a person or not. Instead
// we need to make sure there is a join with the outer scope before it makes it to
// the choose. To do that, the AggregateOuterLookup node just keeps track of every
// value it has seen from the outer and makes sure that each right has a join with
// it.
export class AggregateOuterLookup extends BinaryFlow {
  _nodeName:string = "AggregateOuterLookup";
  traceType = TraceNode.AggregateOuterLookup;
  keyFunc:KeyFunction;
  leftIndex:KeyOnlyIntermediateIndex = new KeyOnlyIntermediateIndex();
  rightIndex:IntermediateIndex = new IntermediateIndex();

  constructor(public left:Node, public right:Node, public keyRegisters:Register[]) {
    super(left, right);
    this.keyFunc = IntermediateIndex.CreateKeyFunction(keyRegisters);
  }

  toString() {
    let keys = "[" + this.keyRegisters.map((r) => `[${r.offset}]`).join(", ") + "]";
    //${indent(this.left.toString(), 2)},
    return `AggregateOuterLookup({
  keys: ${keys},
  left: '*snip*',
  right: ${indent(this.right.toString(), 2)}
})`;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let {left, right} = this;
    right.results.clear();
    context.tracer.node(right, prefix);
    right.exec(context, input, prefix, transaction, round, right.results, changes);
    context.tracer.pop(TraceFrameType.Node);
    let result;
    let leftResults = left.results.iter();
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(context, result, transaction, round, results);
    }
    let rightResults = right.results.iter();
    while((result = rightResults.next()) !== undefined) {
      this.onRight(context, result, transaction, round, results);
    }
    return true;
  }

  onLeft(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    let exists = this.leftIndex.has(key);
    this.leftIndex.insert(key, prefix);
    let afterExists = this.leftIndex.has(key);
    let diffs = this.rightIndex.iter(key, 0);
    if(exists && afterExists || !diffs) return;

    let multiplier = 1;
    if(exists && !afterExists) {
      // remove
      multiplier = -1;
    }

    let rightPrefix;
    while(rightPrefix = diffs.next()) {
      let result = copyArray(rightPrefix, "aggregateLookupResult");
      result[result.length - 2] = diffs.round;
      result[result.length - 1] = diffs.count * multiplier;
      context.tracer.capturePrefix(result);
      results.push(result);
    }
  }

  onRight(context:EvaluationContext, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>):void {
    let key = this.keyFunc(prefix);
    this.rightIndex.insert(key, prefix);
    if(this.leftIndex.has(key)) {
      results.push(prefix);
    }
  }
}

export abstract class AggregateNode extends Node {
  abstract name:string;
  traceType = TraceNode.Aggregate;
  groupKey:Function;
  projectKey:Function;
  groups:{[group:string]: {result:any[], [projection:string]: Multiplicity[]}} = {};
  resolved:RawValue[] = [];
  registerLookup:boolean[] = [];

  // @TODO: allow for multiple returns
  constructor(public groupRegisters:Register[], public projectRegisters:Register[], public inputs:(ID|Register)[], public resultRegisters:Register[]) {
    super();
    this.groupKey = IntermediateIndex.CreateKeyFunction(groupRegisters);
    this.projectKey = IntermediateIndex.CreateKeyFunction(projectRegisters);
    for(let reg of groupRegisters) {
      this.registerLookup[reg.offset] = true;
    }
    for(let reg of resultRegisters) {
      this.registerLookup[reg.offset] = true;
    }
  }

  toString() {
    let groups = printFieldArray(this.groupRegisters);
    let projects = printFieldArray(this.projectRegisters);
    let inputs = printFieldArray(this.inputs);
    let results = printFieldArray(this.resultRegisters);
    return `AggregateNode(${this.name}, ${groups}, ${projects}, ${inputs}, ${results})`;
  }

  groupPrefix(group:string, prefix:Prefix) {
    let projection = this.projectKey(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];
    let delta = 0;
    let found = this.groups[group];
    if(!found) {
      found = this.groups[group] = {result: []};
    }
    let counts = found[projection] || [];
    let totalCount = 0;

    let countIx = 0;
    for(let count of counts) {
      // we need the total up to our current round
      if(countIx > prefixRound) break;
      countIx++;
      if(!count) continue;
      totalCount += count;
    }

    if(totalCount && totalCount + prefixCount <= 0) {
      // subtract
      delta = -1;
    } else if(totalCount === 0 && totalCount + prefixCount > 0) {
      // add
      delta = 1;
    } else if(totalCount + prefixCount < 0) {
      // we have removed more values than exist?
      throw new Error("Negative total count for an aggregate projection");
    } else {
      // otherwise this change doesn't impact the projected count, we've just added
      // or removed a support.
    }
    counts[prefixRound] = (counts[prefixRound] || 0) + prefixCount;
    found[projection] = counts;
    return delta;
  }

  getResultPrefix(prefix:Prefix, result:ID, count:Multiplicity):Prefix {
    let neue = copyArray(prefix, "aggregateResult");
    neue[this.resultRegisters[0].offset] = result;
    neue[neue.length - 1] = count;
    let ix = 0;
    while(ix < neue.length - 2) {
      if(!this.registerLookup[ix]) {
        neue[ix] = undefined;
      }
      ix++;
    }
    return neue;
  }

  resolve(prefix:Prefix):RawValue[] {
    let resolved = this.resolved;
    let ix = 0;
    for(let field of this.inputs) {
      if(isRegister(field)) {
        resolved[ix] = GlobalInterner.reverse(prefix[field.offset]);
      } else {
        resolved[ix] = GlobalInterner.reverse(field);
      }
      ix++;
    }
    return resolved;
  }

  stateToResult(state:any):ID {
    let current = this.getResult(state);
    return GlobalInterner.intern(current);
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let group = this.groupKey(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let delta = this.groupPrefix(group, prefix);
    let op = this.add;
    if(!delta) return false;
    if(delta < 0) op = this.remove;

    let groupStates = this.groups[group].result;
    let currentState = groupStates[prefixRound];
    if(!currentState) {
      // otherwise we have to find the most recent result that we've seen
      for(let ix = 0, len = Math.min(groupStates.length, prefixRound); ix < len; ix++) {
        let current = groupStates[ix];
        if(current === undefined) continue;
        currentState = copyHash(current, "AggregateState");
      }
    }
    let resolved = this.resolve(prefix);
    let start = prefixRound;
    groupStates[prefixRound] = currentState;
    if(!currentState) {
      currentState = groupStates[prefixRound] = op(this.newResultState(), resolved);
      let cur = this.getResultPrefix(prefix, this.stateToResult(currentState), 1);
      results.push(cur);
      start = prefixRound + 1;
    }
    for(let ix = start, len = Math.max(groupStates.length, prefixRound + 1); ix < len; ix++) {
      let current = groupStates[ix];
      if(current === undefined) continue;

      let prevResult = this.getResultPrefix(prefix, this.stateToResult(current), -1);
      current = groupStates[prefixRound] = op(current, resolved);
      let neueResult = this.getResultPrefix(prefix, this.stateToResult(current), 1);
      results.push(prevResult);
      results.push(neueResult);
    }
    return true;
  }

  abstract add(state:any, resolved:RawValue[]):any;
  abstract remove(state:any, resolved:RawValue[]):any;
  abstract getResult(state:any):RawValue;
  abstract newResultState():any;

}

//------------------------------------------------------------------------------
// SortNode
//------------------------------------------------------------------------------

export abstract class SortNode extends Node {
  name = "Sort";
  traceType = TraceNode.Aggregate;
  groupKey:Function;
  projectKey:Function;
  groups:{[group:string]: {result:any[], [projection:string]: Multiplicity[]}} = {};
  resolved:ID[] = [];
  resolvedDirections:RawValue[] = [];
  sortRegisters:Register[];

  // @TODO: allow for multiple returns
  constructor(public groupRegisters:Register[], public projectRegisters:Register[], public directions:(ID|Register)[], public resultRegisters:Register[]) {
    super();
    this.groupKey = IntermediateIndex.CreateKeyFunction(groupRegisters);
    this.projectKey = IntermediateIndex.CreateKeyFunction(projectRegisters);
    this.sortRegisters = groupRegisters.concat(projectRegisters).filter(isRegister);
  }

  groupPrefix(group:string, prefix:Prefix) {
    let projection = this.projectKey(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];
    let delta = 0;
    let found = this.groups[group];
    if(!found) {
      found = this.groups[group] = {result: []};
    }
    let counts = found[projection] || [];
    let totalCount = 0;

    let countIx = 0;
    for(let count of counts) {
      // we need the total up to our current round
      if(countIx > prefixRound) break;
      countIx++;
      if(!count) continue;
      totalCount += count;
    }
    if(totalCount && totalCount + prefixCount <= 0) {
      // subtract
      delta = -1;
    } else if(totalCount === 0 && totalCount + prefixCount > 0) {
      // add
      delta = 1;
    } else if(totalCount + prefixCount < 0) {
      // we have removed more values than exist?
      throw new Error("Negative total count for an aggregate projection");
    } else {
      // otherwise this change doesn't impact the projected count, we've just added
      // or removed a support.
    }
    counts[prefixRound] = (counts[prefixRound] || 0) + prefixCount;
    found[projection] = counts;
    return delta;
  }

  resolve(prefix:Prefix):ID[] {
    let {resolved, resolvedDirections} = this;
    if(resolved.length < prefix.length) resolved.length = prefix.length;
    for(let field of this.sortRegisters) {
      if(isRegister(field)) {
        resolved[field.offset] = prefix[field.offset];
      }
    }
    let ix = 0;
    for(let field of this.directions) {
      if(isRegister(field)) {
        resolvedDirections[ix] = GlobalInterner.reverse(prefix[field.offset]);
      } else {
        resolvedDirections[ix] = GlobalInterner.reverse(field);
      }
      ix++;
    }
    return resolved;
  }

  isGreater(a:Prefix, b:Prefix):string|false {
    let {resolvedDirections} = this;
    let dirIx = 0;
    let dir = resolvedDirections[dirIx] || "up";
    for(let register of this.projectRegisters) {
      let {offset} = register;
      let aV = GlobalInterner.reverse(a[offset]);
      let bV = GlobalInterner.reverse(b[offset]);
      if((dir === "up" &&  aV > bV) ||
         (dir === "down" && aV < bV)) {
        return dir;
      } else if(aV !== bV) {
        return false;
      }
      dirIx++;
      dir = resolvedDirections[dirIx] || dir;
    }
    return false;
  }

  prefixEqual(a:Prefix, b:Prefix) {
    let ix = -1;
    for(let field of a) {
      ix++;
      if(field !== b[ix]) {
        return false;
      }
    }
    return true;
  }

  exec(context:EvaluationContext, input:Change, prefix:Prefix, transaction:number, round:number, results:Iterator<Prefix>, changes:Transaction):boolean {
    let group = this.groupKey(prefix);
    let prefixRound = prefix[prefix.length - 2];
    let delta = this.groupPrefix(group, prefix);
    let op = this.add;
    if(!delta) return false;
    if(delta < 0) op = this.remove;

    let groupStates = this.groups[group].result;
    let currentState = groupStates[prefixRound];
    if(!currentState) {
      // otherwise we have to find the most recent result that we've seen
      for(let ix = 0, len = Math.min(groupStates.length, prefixRound); ix < len; ix++) {
        let current = groupStates[ix];
        if(current === undefined) continue;
        currentState = copyHash(current, "SortState");
      }
    }
    let resolved = this.resolve(prefix);
    let start = prefixRound;
    groupStates[prefixRound] = currentState;
    if(!currentState) {
      currentState = groupStates[prefixRound] = op(this.newResultState(), resolved, prefixRound, results);
      start = prefixRound + 1;
    }
    for(let ix = start, len = Math.max(groupStates.length, prefixRound + 1); ix < len; ix++) {
      let current = groupStates[ix];
      if(current === undefined) continue;

      current = groupStates[prefixRound] = op(current, resolved, ix, results);
    }
    return true;
  }

  resultPrefix(prefix:Prefix, outOffset:number, pos:number, round:number, count:Multiplicity) {
    let item = copyArray(prefix, "SortResult");
    // add one here because we're one indexed
    item[outOffset] = GlobalInterner.intern(pos + 1);
    item[item.length - 2] = round;
    item[item.length - 1] = count;
    return item;
  }

  add = (state:any, resolved:ID[], round:number, results:Iterator<Prefix>):any => {
    let {resultPrefix} = this;
    let neue = copyArray(resolved, "SortIntermediate");
    let ix = 0;
    for(let item of state.sorted) {
      if(this.isGreater(item, resolved)) {
        break;
      }
      ix++;
    }
    let outOffset = this.resultRegisters[0].offset;
    state.sorted.splice(ix, 0, neue);
    results.push(resultPrefix(neue, outOffset, ix, round, 1));
    ix++;
    for(; ix < state.sorted.length; ix++) {
      let cur = state.sorted[ix];
      results.push(resultPrefix(cur, outOffset, ix - 1, round, -1));
      results.push(resultPrefix(cur, outOffset, ix, round, 1));
    }
    return state;
  }

  remove = (state:any, resolved:ID[], round:number, results:Iterator<Prefix>):any => {
    let {resultPrefix} = this;
    let ix = 0;
    let found = false;
    for(let item of state.sorted) {
      if(this.prefixEqual(item, resolved)) {
        break;
      }
      ix++;
    }
    state.sorted.splice(ix, 1);
    let outOffset = this.resultRegisters[0].offset;
    results.push(resultPrefix(resolved, outOffset, ix, round, -1));
    for(; ix < state.sorted.length; ix++) {
      let cur = state.sorted[ix];
      results.push(resultPrefix(cur, outOffset, ix + 1, round, -1));
      results.push(resultPrefix(cur, outOffset, ix, round, 1));
    }
    return state;
  }

  newResultState():any {
    return {sorted: [], sortLookup: {}};
  }

}

//------------------------------------------------------------------------------
// Block
//------------------------------------------------------------------------------

export class Block {
  constructor(public name:string, public nodes:Node[], public totalRegisters:number) {
    for(let ix = 0; ix < this.totalRegisters + 2; ix++) {
      this.initial[ix] = undefined as any;
    }
  }

  results = new Iterator<Prefix>();
  initial:Prefix = createArray();

  toString() {
    let content = this.nodes.map(toString).join(",\n");
    return `Block("${this.name}", [\n  ${indent(content, 2)}\n])`;
  }

  exec(context:EvaluationContext, input:Change, transaction:Transaction):boolean {
    this.results.clear();
    this.results.push(this.initial.slice());

    let prefix;
    let iter = this.results;
    for(let node of this.nodes) {
      node.results.clear();
      if(iter.length === 0) {
        if(node instanceof AntiJoin) {
          node.exec(context, input, this.initial.slice(), transaction.transaction, transaction.round, node.results, transaction);
          iter = node.results.iter();
        }
      } else {
        while((prefix = iter.next()) !== undefined) {
          context.tracer.node(node, prefix);
          node.exec(context, input, prefix, transaction.transaction, transaction.round, node.results, transaction);
          context.tracer.pop(TraceFrameType.Node);
        }
        iter = node.results.iter();
      }
    }

    return true;
  }
}

//------------------------------------------------------------------------------
// EvaluationContext
//------------------------------------------------------------------------------

export class EvaluationContext {
  distinctIndex = new DistinctIndex();
  intermediates:{[key:string]: IntermediateIndex} = {};
  exportIndex:{[beav:string]: number} = {};
  tracer:Tracer;

  constructor(public index:Index) {
   this.tracer = TRACE ? new Tracer(this) : new NoopTracer(this);
  }
}

//------------------------------------------------------------------------------
// Transaction
//------------------------------------------------------------------------------

export type ExportHandler = (blockChanges:{[id:number]: Change[]|undefined}) => void;

export class Transaction {
  round = -1;
  changes:Change[] = []
  lastFrame = 0;
  protected outputs = new Iterator<Change>();
  protected roundChanges:Change[][] = [];
  protected frameCommits:Change[] = [];
  protected framePartialCommits:RemoveVsChange[] = [];
  protected exportedChanges:{[blockId:number]: Change[]} = {};
  constructor(public context:EvaluationContext, public transaction:number, public blocks:Block[], protected exportHandler?:ExportHandler) {
    context.tracer.transaction(transaction);
  }

  output(context:EvaluationContext, change:Change) {
    // debug("        E~", change.toString(), context.tracker.activeBlock);
    let {outputs} = this;
    let {distinctIndex, tracer} = context;
    tracer.maybeOutput(change);
    outputs.clear();
    distinctIndex.distinct(change, outputs);
    tracer.postDistinct();
    outputs.reset();
    let output;
    while(output = outputs.next()) {
      tracer.output(output);
      // debug("          <-", output.toString())
      let cur = this.roundChanges[output.round] || createArray("roundChangesArray");
      cur.push(output);
      this.roundChanges[output.round] = cur;
    }
    tracer.pop(TraceFrameType.MaybeOutput);
  }

  commit(context:EvaluationContext, change:Change) {
    context.tracer.commit(change);
    let {outputs} = this;
    if(change instanceof RemoveVsChange) {
      this.framePartialCommits.push(change);
    } else {
      this.frameCommits.push(change);
    }
    // debug("          <-!", change.toString())
  }

  export(context:EvaluationContext, blockId:number, change:Change) {
    if(!this.exportedChanges[blockId]) this.exportedChanges[blockId] = [change];
    else this.exportedChanges[blockId].push(change);
  }

  protected prepareRound(context:EvaluationContext, changeIx:number) {
    let {roundChanges, changes} = this;
    let next = changes[changeIx];
    let maxRound = roundChanges.length;
    let oldLength = changes.length;
    if(!next && this.round < maxRound) {
      for(let ix = this.round + 1; ix < maxRound; ix++) {
        let nextRoundChanges = roundChanges[ix];
        if(nextRoundChanges) {
          this.collapseMultiplicity(nextRoundChanges, changes);

          // If we've got new changes to go through, we're done
          if(oldLength < changes.length) return;
        }
      }
    }
    let {frameCommits, framePartialCommits} = this;
    if(!next && (frameCommits.length || framePartialCommits.length)) {
      for(let commit of framePartialCommits) {
        commit.toRemoveChanges(context, frameCommits);
      }

      let collapsedCommits:Change[] = [];
      this.collapseCommits(this.frameCommits, collapsedCommits);
      let collapsedChanges:Change[] = [];
      this.collapseMultiplicity(collapsedCommits, collapsedChanges);

      if(collapsedChanges.length) {
        context.tracer.frame(collapsedChanges);
        this.lastFrame = this.changes.length;
        this.round = -1;
        this.roundChanges = [];
        this.frameCommits = [];
        this.framePartialCommits = [];
        for(let commit of collapsedChanges) {
          if(commit.count > 0) commit.count = Infinity;
          else if(commit.count < 0) commit.count = -Infinity;
          // debug("    ->! ", commit.toString())
          this.output(context, commit);
        }
        this.prepareRound(context, changeIx);
        // debug(" ---------------- NEW FRAME -------------------")
      }
    }
  }

  protected collapseCommits(changes:Change[], results:Change[] /* output */) {
    // We sort the changes to group all the same EAVs together.
    changes.sort((a,b) => {
      let nodeDiff = a.n - b.n;
      if(!nodeDiff) {
        let eDiff = a.e - b.e;
        if(!eDiff) {
          let aDiff = a.a - b.a;
          if(!aDiff) {
            let vDiff = a.v - b.v;
            return vDiff;
          }
          return aDiff;
        }
        return eDiff;
      }
      return nodeDiff;
    });
    let changeIx = 0;
    for(let changeIx = 0; changeIx < changes.length; changeIx++) {
      let current = changes[changeIx];
      let currentType = current instanceof RemoveChange ? true : false;
      if(currentType) {
        current = new RemoveChange(current.e, current.a, current.v, current.n, current.transaction, current.round, current.count);
      } else {
        current = new Change(current.e, current.a, current.v, current.n, current.transaction, current.round, current.count);
      }

      // Collapse each subsequent matching EAV's multiplicity into the current one's.
      while(changeIx + 1 < changes.length) {
        let next = changes[changeIx + 1];
        if(current.n === next.n && next.e == current.e && next.a == current.a && next.v == current.v) {
          current.count += next.count;
          changeIx++;
        } else {
          break;
        }
      }

      current.round = 0;
      if(currentType && current.count < 0) {
        results.push(current);
      } else if(!currentType && current.count > 0) {
        results.push(current);
      }
    }

    return results;
  }

  protected collapseMultiplicity(changes:Change[], results:Change[] /* output */, createNew = false) {
    // We sort the changes to group all the same EAVs together.
    changes.sort((a,b) => {
      let eDiff = a.e - b.e;
      if(!eDiff) {
        let aDiff = a.a - b.a;
        if(!aDiff) {
          return a.v - b.v;
        }
        return aDiff;
      }
      return eDiff;
    });
    let changeIx = 0;
    for(let changeIx = 0; changeIx < changes.length; changeIx++) {
      let current = changes[changeIx];
      if(createNew) {
        current = new Change(current.e, current.a, current.v, current.n, current.transaction, current.round, current.count);
      }

      // Collapse each subsequent matching EAV's multiplicity into the current one's.
      while(changeIx + 1 < changes.length) {
        let next = changes[changeIx + 1];
        if(next.e == current.e && next.a == current.a && next.v == current.v) {
          current.count += next.count;
          changeIx++;
        } else {
          break;
        }
      }
      if(current.count !== 0) results.push(current);
    }

    return results;
  }

  exec(context:EvaluationContext) {
    let {changes, roundChanges} = this;
    let {index, tracer} = context;
    tracer.frame([]);
    let total = 0;
    let frames = 0;
    let changeIx = 0;
    let iterationLimit = 10000;
    this.prepareRound(context, changeIx);
    while(changeIx < changes.length) {
      let change = changes[changeIx];
      tracer.input(change);
      total++;
      if(total > iterationLimit) {
        console.error(`Error: Program failed to fixpoint after ${iterationLimit} iterations. This is likely due to an unbounded cycle in the program.`);
        break;
      }
      if(this.round !== 0 && change.round === 0) {
        frames++;
        if(frames > 10) {
          console.error("Failed to terminate");
          break;
        }
      }
      this.round = change.round;
      // debug("Round:", this.round);
      // debug("  <- ", change.toString())
      for(let block of this.blocks) {
        tracer.block(block.name);
        //debug("    ", block.name);
        block.exec(context, change, this);
        tracer.pop(TraceFrameType.Block);
      }

      // debug("");
      index.insert(change);

      tracer.pop(TraceFrameType.Input);
      changeIx++;
      this.prepareRound(context, changeIx);
    }

    let exportingBlocks = Object.keys(this.exportedChanges);
    if(exportingBlocks.length) {
      if(!this.exportHandler) throw new Error("Unable to export changes without export handler.");

      for(let blockId of exportingBlocks) {
        let rawExports:Change[] = createArray("rawExportsArray");
        this.collapseMultiplicity(this.exportedChanges[+blockId], rawExports);
        let exports:Change[] = createArray("exportsArray");
        for(let change of rawExports) {
          let {e, a, v, count} = change;
          let beav = `${blockId}|${e}|${a}|${v}`;
          let old = context.exportIndex[beav] || 0;
          let neue = old + count;
          let delta = 0;
          context.exportIndex[beav] = neue;

          // Once you go negative you don't go back.
          if(old === 0 && neue > 0) delta = 1;
          else if(old > 0 && neue === 0) delta = -1;

          if(delta) {
            let exportedChange = new Change(e, a, v, change.n, this.transaction, 0, delta);
            exports.push(exportedChange);
          }
        }

        this.exportedChanges[+blockId] = exports;
      }
      try {
        this.exportHandler(this.exportedChanges);
      } catch(e) {
        tracer.pop(TraceFrameType.Transaction);
        throw e;
      }
    }

    // Once the transaction is effectively done, we need to clean up after ourselves. We
    // arena allocated a bunch of IDs related to function call outputs, which we can now
    // safely release.
    GlobalInterner.releaseArena("functionOutput");
    tracer.pop(TraceFrameType.Transaction);
  }
}

export class BlockChangeTransaction extends Transaction {
  constructor(public context:EvaluationContext, public transaction:number, public added:Block[], public removed:Block[], public blocks:Block[], protected exportHandler?:ExportHandler) {
    super(context, transaction, blocks, exportHandler);
  }

  exec(context:EvaluationContext) {
    // To remove a block, we run a change with negative count through the system that
    // is meant to compute all the results the block has generated and remove them.
    for(let remove of this.removed) {
      remove.exec(context, BLOCK_REMOVE, this);
    }

    // To add a block, we do the same as remove, but with a positive change that causes
    // the block to compute all results based on the state of the indexes
    for(let add of this.added) {
      add.exec(context, BLOCK_ADD, this);
    }

    super.exec(context);
  }
}

// window["counts"] = {};
