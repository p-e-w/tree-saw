#!/usr/bin/env node

// tree-saw - tree-sitter and compilers testing each other
//
// Copyright (c) 2018 Philipp Emanuel Weidmann <pew@worldwidemann.com>
//
// Nemo vir est qui mundum non reddat meliorem.
//
// Released under the terms of the MIT License
// (https://opensource.org/licenses/MIT)

const package = require("./package.json");

const fs = require("fs");
const {spawnSync} = require("child_process");

const _ = require("lodash");
const RandExp = require("randexp");
const program = require("commander");
const PD = require("probability-distributions");
const {Document} = require("tree-sitter");

class Node {
  constructor(type, contents) {
    this.type = type;
    // Either a string or an array of nodes
    this.contents = contents;
  }

  // Calls `callback` with each pruned variation of the node's tree, then returns.
  // Stops if a call to `callback` returns `false`.
  prune(callback) {
    if (_.isArray(this.contents)) {
      const length = this.contents.length;

      if ((this.type === "REPEAT" && length > 0) || (this.type === "REPEAT1" && length > 1)) {
        // Any subtree may be removed
        for (let i = 0; i < length; i++) {
          const tree = _.cloneDeep(this);
          tree.contents.splice(i, 1);
          if (!callback(tree)) {
            return;
          }
        }
      }

      for (let i = 0; i < length; i++) {
        let callbackResult = true;

        this.contents[i].prune(t => {
          const tree = _.cloneDeep(this);
          tree.contents[i] = t;
          callbackResult = callback(tree);
          return callbackResult;
        });

        if (!callbackResult) {
          return;
        }
      }
    }
  }

  toString(separator) {
    return _.flattenDeep(this.toArray()).join(separator);
  }

  toArray() {
    if (_.isArray(this.contents)) {
      return this.contents.map(t => t.toArray());
    } else {
      return [this.contents];
    }
  }
}

class Generator {
  constructor(grammar, maxDepth, meanRepeat, maxRegexRepeat) {
    if (grammar.hasOwnProperty("externals") && grammar.externals.length > 0) {
      throw "Grammar contains external symbols; such grammars are not supported.";
    }
    this.grammar = grammar;
    this.maxDepth = maxDepth;
    this.meanRepeat = meanRepeat;
    this.maxRegexRepeat = maxRegexRepeat;
  }

  generate(rule, depth = 1) {
    const type = rule.type;

    switch (type) {
      case "BLANK":
        return new Node(type, "");
      case "STRING":
        return new Node(type, rule.value);
      case "PATTERN":
        if (!rule.hasOwnProperty("randexp")) {
          rule.randexp = new RandExp(rule.value);
          rule.randexp.max = this.maxRegexRepeat;
        }
        return new Node(type, rule.randexp.gen());
      case "SYMBOL":
        return new Node(type, [this.generate(this.grammar.rules[rule.name], depth + 1)]);
      case "SEQ":
        return new Node(type, rule.members.map(r => this.generate(r, depth + 1)));
      case "CHOICE":
        let nextRule;
        if (depth > this.maxDepth) {
          if (!rule.hasOwnProperty("sampleWeights")) {
            rule.sampleWeights = rule.members.map(r => {
              const d = this.expectedDepth(r);
              return 1 / ((d === Infinity) ? 1000 : d);
            });
          }
          nextRule = PD.sample(rule.members, 1, true, rule.sampleWeights)[0];
        } else {
          nextRule = PD.sample(rule.members, 1, true)[0];
        }
        return new Node(type, [this.generate(nextRule, depth + 1)]);
      case "ALIAS":
        return new Node(type, [this.generate(rule.content, depth + 1)]);
      case "REPEAT":
      case "REPEAT1":
        let n = PD.rpois(1, this.meanRepeat)[0];
        if (n === 0 && type === "REPEAT1") {
          n = 1;
        }
        return new Node(type, Array(n).fill(0).map(() => this.generate(rule.content, depth + 1)));
      case "TOKEN":
      case "PREC":
      case "PREC_LEFT":
      case "PREC_RIGHT":
      case "PREC_DYNAMIC":
        return new Node(type, [this.generate(rule.content, depth + 1)]);
      default:
        throw "Unrecognized rule type: " + type;
    }
  }

  expectedDepth(rule, symbolStack = []) {
    if (!rule.hasOwnProperty("expectedDepth")) {
      switch (rule.type) {
        case "BLANK":
        case "STRING":
        case "PATTERN":
          rule.expectedDepth = 1;
          break;
        case "SYMBOL":
          if (symbolStack.includes(rule.name)) {
            // Self-reference
            rule.expectedDepth = Infinity;
          } else {
            rule.expectedDepth = 1 + this.expectedDepth(this.grammar.rules[rule.name], [...symbolStack, rule.name]);
          }
          break;
        case "SEQ":
          rule.expectedDepth = 1 + _.max(rule.members.map(r => this.expectedDepth(r, symbolStack)));
          break;
        case "CHOICE":
          rule.expectedDepth = 1 + _.mean(rule.members.map(r => this.expectedDepth(r, symbolStack)));
          break;
        case "ALIAS":
        case "REPEAT":
        case "REPEAT1":
        case "TOKEN":
        case "PREC":
        case "PREC_LEFT":
        case "PREC_RIGHT":
        case "PREC_DYNAMIC":
          rule.expectedDepth = 1 + this.expectedDepth(rule.content, symbolStack);
          break;
        default:
          throw "Unrecognized rule type: " + rule.type;
      }
    }
    return rule.expectedDepth;
  }
}

function run(grammarFile, options) {
  const grammar = JSON.parse(fs.readFileSync(grammarFile, "utf8"));
  const startRule = grammar.rules[Object.keys(grammar.rules)[0]];
  const generator = new Generator(grammar, options.depth, options.repeat, options.regexRepeat);

  const hasGrammar = options.hasOwnProperty("grammar");
  const hasCompiler = options.hasOwnProperty("compiler");
  const canCheckError = hasGrammar || hasCompiler;

  const document = new Document();
  if (hasGrammar) {
    document.setLanguage(require(options.grammar));
  }

  const compilerArgs = (hasCompiler ? options.compiler.split(/\s+/) : null);

  function getError(output) {
    if (hasGrammar) {
      document.setInputString(output);
      document.parse();
      if (document.rootNode.hasError()) {
        return "AST error";
      }
    }

    if (hasCompiler) {
      const {status, stdout, stderr} = spawnSync(compilerArgs[0], compilerArgs.slice(1), { input: output });
      if (status !== 0) {
        return "Compiler error:\n" + (stdout + stderr).trim();
      }
    }

    return null;
  }

  let results = 0;

  while (results < options.results) {
    let tree = generator.generate(startRule);
    let output = tree.toString(options.separator);

    if (canCheckError) {
      let error = getError(output);

      if (error !== null) {
        while (true) {
          let treePruned = false;

          tree.prune(t => {
            const output2 = t.toString(options.separator);
            const error2 = getError(output2);
            if (error2 !== null) {
              tree = t;
              output = output2;
              error = error2;
              treePruned = true;
              return false;
            }
            return true;
          });

          if (!treePruned) {
            break;
          }
        }

        console.log(">>>>>RESULT");
        console.log(">>>>>SOURCE");
        console.log(output);
        console.log("<<<<<SOURCE");

        if (hasGrammar) {
          document.setInputString(output);
          document.parse();
          console.log(">>>>>AST");
          console.log(document.rootNode.toString());
          console.log("<<<<<AST");
        }

        console.log(">>>>>ERROR");
        console.log(error);
        console.log("<<<<<ERROR");
        console.log("<<<<<RESULT");

        results++;
      }
    } else {
      console.log(">>>>>RESULT");
      console.log(">>>>>SOURCE");
      console.log(output);
      console.log("<<<<<SOURCE");
      console.log("<<<<<RESULT");

      results++;
    }
  }
}

let showHelp = true;

program
  .description(package.description)
  .arguments("<grammar-json-file>")
  .option("--compiler <command>", "command line of compiler to pass output to")
  .option("--grammar <package>", "name of tree-sitter grammar package used to parse output")
  .option("--results <n>", "number of results to find before exiting", parseInt, 1)
  .option("--separator <s>", "string used to separate grammar tokens in output", " ")
  .option("--depth <n>", "recursion depth after which to apply depth control heuristics", parseInt, 10)
  .option("--repeat <lambda>", "mean of Poisson distribution from which REPEAT lengths are drawn", parseFloat, 5)
  .option("--regex-repeat <n>", "maximum free length to which to expand repetitions in regular expressions", parseInt, 5)
  .version(package.version)
  .action(grammarFile => {
    showHelp = false;
    run(grammarFile, program);
  })
  .parse(process.argv);

if (showHelp) {
  program.help();
}
