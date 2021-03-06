/*
 * A component is an event emitter.
 * It may own zero or more other components.
 * Components may be bound and later unbound to/from parent.
 * Component may only be bound to at most one other component (the parent).
 * Weak-bound components do not close their parent when they are closed.
 * Errors in subcomponents are propagated to their parent as warnings.
 * Warnings and Information (events "info" and "warn") are propagated to the parent.
 * Components automatically unbind from their parent (if any) when closed.
 * A component may automatically be "ready" when created, or may become ready later by calling $component.ready().
 * wait_for_ready() waits until the component and all of its subcomponents are ready.
 */
const _ = require('lodash');
const EventEmitter = require('eventemitter');
const EventManager = require('event-manager');

module.exports = Component;

Component.prototype = new EventEmitter();

Component.debug = false;

Component.tree = tree;

function Component(name, is_ready) {
	EventEmitter.call(this);

	if (arguments.length === 0) {
		return this;
	}

	/* Subcomponents */
	const components = new Set();
	/* "Ready" promise */
	let ready_res;
	let ready_rej;
	let ready = false;
	const ready_promise = new Promise((res, rej) => { ready_res = res; ready_rej = rej; })
		.then(data => { ready = true; return data; });
	/* "close" can only be called once */
	let closed = false;

	let $component;

	/* Event manager, to avoid leaking handlers */
	const events = new EventManager();
	const $on = events.subscribe;
	const $off = events.unsubscribe;

	const bind = (sub, weak) => {
		if (!sub) {
			throw new Error('Parameter cannot be null/undefined');
		}
		const data = sub.$component;
		if (!data) {
			bind(new ComponentWrapper(sub));
			return;
		}
		if (data.bound) {
			throw new Error(`Subcomponent [${data.name}] double-bound to [${name}]`);
		}
		components.add(sub);
		data.bound = true;
		data.parent = this;
		bind_child_to_parent(sub, this, weak);
	};

	const unbind = sub => {
		if (!sub) {
			throw new Error('Parameter cannot be null/undefined');
		}
		const data = sub.$component;
		if (!components.delete(sub)) {
			throw new Error('Unbind failed, given component is not bound to this component');
		}
		data.bound = false;
		data.parent = null;
	};

	const set_ready = () => {
		if (Component.debug) {
			console.info(`Component is internally ready: [${$component.name}]`);
		}
		ready_res();
	};

	const set_failed = err => {
		if (ready) {
			if (Component.debug) {
				console.info(`Component failed: [${$component.name}]`, err);
			}
		} else {
			if (Component.debug) {
				console.info(`Component failed to initialise: [${$component.name}]`, err);
			}
		}
		/* Add a null catcher to avoid UnhandledPromiseRejectionWarning */
		ready_promise.catch(() => null);
		ready_rej(err);
		this.close();
	};

	const link_event = (event, recurse) => {
		components.forEach(component => {
			$on(component, event, (...args) => this.emit(event, ...args));
			if (recurse) {
				component.$component.link_event(event);
			}
		});
	};

	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		if (Component.debug) {
			console.info(`Closing component [${$component.name}]`);
		}
		ready_promise.then(() => null, () => null);
		const do_close = () => {
			try {
				this.emit('close');
			} finally {
				if (Component.debug) {
					console.info(`Closed component [${$component.name}]`);
				}
				/* Unbind from parent */
				if ($component.parent) {
					$component.parent.unbind(this);
				}
				/* Unbind events */
				this.removeAllListeners();
				events.unsubscribe_all();
			}
		};
		if (this.close_async) {
			this.close_async().catch(err => this.emit('error', err)).then(do_close);
		} else {
			do_close();
		}
	};

	const wait_for_ready = () =>
		Promise.all([ready_promise, ...[...components].map(component => component.wait_for_ready())]);

	const objectify = x => _.isString(x) ? { message: x } : x;
	const warn = data => this.emit('warn', _.assign({ type: 'warn', source: this }, objectify(data)));
	const info = data => this.emit('info', _.assign({ type: 'info', source: this }, objectify(data)));

	const rename = new_name => {
		if (Component.info) {
			console.debug(`Renaming component [${$component.name}] to [${new_name}]`);
		}
		$component.name = new_name;
	};

	$component = {
		bound: false,
		/* Name of this component */
		name, rename,
		/* Add subcomponent */
		bind,
		/* Remove subcomponent */
		unbind,
		/* Recursively bind an event of all subcomponents to this one */
		link_event,
		/* Resolves when component and all subcomponents are ready */
		wait_for_ready,
		/* Call when component is ready */
		ready: set_ready,
		/* Is this component ready (ignoring subcomponents)? */
		self_is_ready: () => ready,
		/* Call if component fails to become ready */
		failed: set_failed,
		/* Used when wrapping eventemitters */
		target: this,
		/* Parent component */
		parent: null,
		/* Subcomponents */
		children: components,
		/* Bind events in a way that we can unbind automatically on close */
		$on, $off,
		/* Send a message which gets tagged with this object then propagated up the tree */
		warn, info,
		/* Styling strings for tree renderer */
		style: [/* bold, strike, red, blue, reverse, etc */]
	};

	const direct = { $on, $off, $component, bind, unbind, close, wait_for_ready, warn, info };
	for (const key of Object.keys(direct)) {
		const value = direct[key];
		Object.defineProperty(this, key, { value });
	}

	this.on('error', set_failed);

	if (Component.debug) {
		console.info(`Creating component [${$component.name}]`);
	}

	if (is_ready) {
		$component.ready();
	}

}

function bind_child_to_parent(child, parent, weak) {
	const name = obj => obj.$component ? obj.$component.name : obj.constructor ? obj.constructor.name : '?';
	if (Component.debug) {
		console.info(`${weak ? 'Weak' : 'Strong'}-binding [${name(child)}] to component [${name(parent)}]`);
	}
	if (child.close) {
		const on_parent_close = () => {
			try {
				child.close();
			} catch (err) {
				console.error(`Error occurred progagating close event from ${name(parent)} down to child ${name(child)}:`, err);
			}
		};
		if (child.$on) {
			child.$on(parent, 'close', on_parent_close);
		} else {
			parent.on('close', on_parent_close);
		}
	}
	parent.$on(child, 'warn', data => parent.emit('warn', data));
	parent.$on(child, 'info', data => parent.emit('info', data));
	parent.$on(child, 'error', error => {
		if (Component.debug) {
			console.info(`Propagating error from [${name(child)}] as warning to parent [${name(parent)}]`);
		}
		parent.warn({ type: 'subcomponent-error', origin: child, error });
	});
	if (!weak) {
		parent.$on(child, 'close', () => {
			try {
				parent.close();
			} catch (err) {
				console.error(`Error occurred progagating close event from ${name(child)} up to parent ${name(parent)}:`, err);
			}
		});
	}
}

ComponentWrapper.prototype = new Component();
function ComponentWrapper(obj, name) {
	name = name || 'Wrapper';
	Component.call(this, name, true);

	bind_child_to_parent(obj, this, false);

	/* Close the wrapper if the child errs */
	this.$on(obj, 'error', () => this.close());

	this.$component.target = obj;
}

/******************************************************************************/

function tree(component, opts) {
	const term = {
		bold: 1,
		dark: 2,
		reverse: 3,
		italic: 4,
		blink: 5,
		strike: 9,

		black: 30,
		red: 31,
		green: 32,
		yellow: 33,
		blue: 34,
		magenta: 35,
		cyan: 36,
		white: 37,

		br_black: 90,
		br_red: 91,
		br_green: 92,
		br_yellow: 93,
		br_blue: 94,
		br_magenta: 95,
		br_cyan: 96,
		br_white: 97,

		bg_black: 40,
		bg_red: 41,
		bg_green: 42,
		bg_yellow: 43,
		bg_blue: 44,
		bg_magenta: 45,
		bg_cyan: 46,
		bg_white: 47,

		bg_br_black: 100,
		bg_br_red: 101,
		bg_br_green: 102,
		bg_br_yellow: 103,
		bg_br_blue: 104,
		bg_br_magenta: 105,
		bg_br_cyan: 106,
		bg_br_white: 107,
	};
	const { upward, downward, highlight, ready } = _.assign({ upward: false, downward: true, highlight: component }, opts);
	const children = [];
	const t = comp =>
		comp.$component.target === comp ?
			'' :
			comp.$component.target.constructor ?
				` -> ${comp.$component.target.constructor.name}` :
				'?';
	const hl = (comp, name) => {
		const codes = comp.$component.style.map(style => {
			if (_.has(term, style)) {
				return term[style];
			} else {
				console.warn(`No style defined for "${style}"`);
				return null;
			}
		}).filter(x => x !== null);
		if (comp === highlight) {
			codes.push(term.bold, term.reverse);
		}
		if (ready && !comp.$component.self_is_ready()) {
			codes.push(term.dark, term.strike);
		}
		return codes.length ? `\x1b[${codes.join(';')}m${name}\x1b[0m` : name;
	};
	const x = (comp, nodes) => ({
		label: hl(comp, comp.$component.name) + t(comp),
		nodes
	});
	let data = x(component, children);
	if (upward && downward) {
		data.label += ' *';
	}
	if (upward) {
		let iter = component;
		while (iter) {
			iter = iter.$component.parent;
			if (iter) {
				data = x(iter, [tree]);
			}
		}
	}
	if (downward) {
		const recurse = obj => x(obj, [...obj.$component.children].map(recurse));
		children.push(...recurse(component).nodes);
	}
	const archy = require('archy');
	return archy(data);
}

/******************************************************************************/

function demo() {
	A.prototype = new Component();
	A.prototype.constructor = A;
	function A() {
		Component.call(this, 'A', true);
		this.$component.style = ['cyan'];
	}

	B.prototype = new Component();
	B.prototype.constructor = B;
	function B() {
		Component.call(this, 'B', true);
		this.$component.style = ['magenta'];
	}

	C.prototype = new Component();
	C.prototype.constructor = C;
	function C() {
		Component.call(this, 'C', false);
		this.$component.style = ['yellow'];
	}

	D.prototype = new EventEmitter();
	D.prototype.constructor = D;
	function D() {
		EventEmitter.call(this);
	}

	Component.debug = !module.parent;

	const a = new A();
	const b = new B();
	const c = new C();
	const d = new D();
	a.bind(b);
	a.bind(c);
	b.bind(d);
	c.$component.ready();

	console.log(tree(a, { ready: true }));

	a.on('warn', msg => console.warn(`Warning "${msg.type}" received at root`));
	a.on('info', msg => console.warn(`Information "${msg.message}" received at root`));
	d.emit('info', { message: 'Some information' });
	d.emit('error', 'lol');

	a.close();
}

if (!module.parent) {
	demo();
}
