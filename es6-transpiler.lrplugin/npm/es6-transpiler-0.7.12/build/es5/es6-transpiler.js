"use strict";

require("es5-shim");
require("es6-shim");

var fs = require("fs");
var error = require("./lib/error");
var defaultOptions = require("./options");
var core = require("./transpiler/core");
var StringAlter = require("string-alter");
var is = require("simple-is");
var ASTQuery = require("astquery");
var node_inject = require("./lib/node_inject");
var esprima = require("./lib/esprima_harmony");

var plugins = [
	core
	, require("./transpiler/numericLiteral")
	, require("./transpiler/classes")
	, require("./transpiler/loopClosures")
	, require("./transpiler/letConst")
	, require("./transpiler/objectLiteral")
	, require("./transpiler/functions")
	, require("./transpiler/spread")
	, require("./transpiler/destructuring")
	, require("./transpiler/quasiLiterals")
	, require("./transpiler/arrayComprehension")
	, require("./transpiler/forOf")
	, require("./transpiler/optimiser")
	, require("./transpiler/RegExp")
	, require("./transpiler/unicode")
	, require("./transpiler/polyfills")

	, {
		setup: function(config) {
			this.__cleanup = config.cleanup;
		}

		, before: function() {
			return !!this.__cleanup;
		}

		, pre: function cleanupTree(node) {
			for (var prop in node) {
				if (prop[0] === "$") {
					delete node[prop];
				}
			}
		}
	}
];

function consoleArgumentsToOptions(args, options) {
	args.forEach(function(arg, index, args) {
		arg = arg + "";
		if ( arg.startsWith("--") ) {
			var val = args[index + 1];
			options[arg.substr(2)] = (!val || val.startsWith("--")) ? true : val;
		}
	});
	return options;
}

module.exports = {
	runned: false

	, node_inject_on: node_inject.node_inject_on
	, node_inject_off: node_inject.node_inject_off

	, setupPlugins: function(config, astQuery) {
		var optionsList = this.optionsList = [];

		config.esprima = esprima;

		plugins.forEach(function(plugin, index) {
			var options = optionsList[index] = {}, passIt = false;

			if( typeof plugin.setup === "function" ) {
				for(var i in config)if(config.hasOwnProperty(i))options[i] = config[i];

				if( plugin.setup(this.alter, this.ast, options, this.src) === false ) {
					passIt = options.passIt = true;
				}
			}

			if ( passIt === false ) {
				if ( typeof plugin.onResultObject === 'function' ) {
					this._onResults.push(plugin.onResultObject);
				}

				astQuery.on(plugin, {prefix: '::', group: index});
			}
		}, this);
	}

	, applyChanges: function(config, doNotReset) {
		if( this.alter.hasChanges() ) {// has changes in classes replacement Step
//			console.log(this.alter.printFragments())
			this.src = this.alter.apply();

			if( doNotReset !== true ) {
				this.ast = esprima.parse(this.src, {
					loc: true,
					range: true,
					comment: true
				});

				error.reset();
				core.reset();

				this.alter = new StringAlter(this.src);
			}

			if( config ) {
				this.reset();
				this.setupPlugins(config);
			}
		}
	}
	, reset: function() {
		this.ast = this.src = null;
		error.reset();

		plugins.forEach(function(plugin) {
			if( typeof plugin.reset === "function" ) {
				plugin.reset();
			}
		});

		this._astQuerySteps = {};
		this._onResults = [];
	}

	, run: function run(config) {
		this.config = config || (config = {});
		for(var i in defaultOptions)if(defaultOptions.hasOwnProperty(i) && !config.hasOwnProperty(i))config[i] = defaultOptions[i];
		if ( config["fromConsole"] === true && Array.isArray(config["consoleArgs"]) ) {
			consoleArgumentsToOptions(config["consoleArgs"], config);
		}

		if( this.runned === true ) {
			this.reset();
		}
		this._astQuerySteps = {};
		this._onResults = [];
		this.runned = true;

		config.fullES6 = true;// by default for now
		config.environments = Array.isArray(config.environments) ? config.environments : [
			// by default
			"browser"
			, "node"
		];

		if( config.resetUnCapturedVariables === true ) {
			config.resetUnCapturedVariables = ['let', 'const', 'fun', 'var'];
		}
		else if( !Array.isArray(config.resetUnCapturedVariables) ) {
			config.resetUnCapturedVariables = [];
		}

		// input
		var isSourceInput = false;
		if( typeof config.filename === "string" ) {
			this.src = String(fs.readFileSync(config.filename));
			isSourceInput = true;
		}
		else if( typeof config.src === "string" || typeof config.src === "object" ) {
			this.src = String(config.src);
			isSourceInput = true;
		}
		else if( typeof config.ast === "object" ) {
			throw new Error("Currently unsupported");
			/*
			src = null;
			ast = config.ast;
			*/
		}

		if( !this.ast && isSourceInput ) {
			this.ast = esprima.parse(this.src, {
				loc: true,
				range: true,
				comment: true
			});
		}
		else {
			throw new Error("Input not found " + config.filename);
		}

		this.alter = new StringAlter(this.src);

		// output
		var output = this.output = {errors: [], src: ""};

		var astQuery = this.loadASTQuery();
		this.setupPlugins(config, astQuery);

		plugins.forEach(this.runPlugin, this);

		// output
		if( error.errors.length ) {
			output.exitcode = -1;
			output.errors = error.errors;
		}
		else if (config.outputType === "ast") {
			// return the modified AST instead of src code
			// get rid of all added $ properties first, such as $parent and $scope
			output.ast = astQuery.getAST({cleanup: true});
		}
		else {
			// apply changes produced by varify and return the transformed src
			//console.log(changes);var transformedSrc = "";try{ transformedSrc = alter(src, changes) } catch(e){ console.error(e+"") };

			this.applyChanges(null, true);
			output.src = this.src;
		}

		if( config.errorsToConsole ) {
			if ( output.errors.length ) {
				process.stderr.write(output.errors.join("\n"));
				process.stderr.write("\n");
				process.exit(-1);
			}
		}

		if( config.outputToConsole === true	) {
			outputToConsole(output, config);
		}

		if( config.outputFilename ) {
			fs.writeFileSync(config.outputFilename, output.src)
		}

		this._onResults.forEach(function(callback) {
			callback(output)
		});

		return output;
	}

	, runPlugin: function(plugin, index) {
		var options = this.optionsList[index];
		var astQuery = this.astQuery;

		if( options.passIt === true ) {
			return;
		}

		if( typeof plugin.before === "function" ) {
			if( plugin.before(this.ast, this.output) === false ) {
				return;
			}
		}

		astQuery.apply({group: index});

		if( typeof plugin.after === "function" ) {
			if( plugin.after(this.ast, this.output) === false ) {
				return;
			}
		}

		if( options.applyChangesAfter ) {
			this.applyChanges(this.config);
		}
	}

	, loadASTQuery: function() {
		// adding custom keys in ASTQuery.VISITOR_KEYS
		var visitorKeys = ASTQuery.getVisitorKeys('es6');
		var IdentifierVK = visitorKeys['Identifier'];
		if ( IdentifierVK.indexOf('default') === -1 ) {
			IdentifierVK.push('default');
		}
		return this.astQuery = new ASTQuery(this.ast, visitorKeys, {onpreparenode: core.onpreparenode});
	}
};

node_inject.setES6transpiler(module.exports);

function outputToConsole(output, config) {
	if (config.outputType === "stats" && output.stats) {
		process.stdout.write(output.stats.toString());
		process.exit(0);
	}
	if (config.outputType === "ast" && output.ast) {
		process.stdout.write(JSON.stringify(output.ast, null, 4));
	}
	if (output.src) {
		process.stdout.write(output.src);
	}
	process.exit(0);
}
