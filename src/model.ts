import {default as maybeAsync, MaybePromise} from 'maybe-async';

import {ScopeInfo, ScopeExpr, parse} from './scopes';

import {
	Store, ObjectId, QueryOptions, UpdateResult, DeleteResult
} from './store';

export {ParseError} from './scopes';

export class Model {
	private _attributes: Set<string> = new Set;
	private _fields: Map<string, FieldDescriptor> = new Map;
	private _relations: Map<string, RelationDescriptor> = new Map;
	private _prototype: object = Object.create(ModelInstance.prototype);

	private queryParams: Map<string, QueryParamHandler[]> = new Map;

	constructor(private store: Store | null, private parent?: Model) {
	}

	get prototype() {
		return this._prototype;
	}

	*fields(): Iterable<string> {
		yield* this._fields.keys();
	}

	*attributes(): Iterable<string> {
		yield* this._attributes;
	}

	*relations(): Iterable<string> {
		yield* Object.keys(this._relations);
	}

	createInstance(): ModelInstance {
		return new ModelInstance(this);
	}

	wrap(data: object): ModelInstance {
		return ModelInstance.wrap(this, data);
	}

	addField(name: string, field: FieldDescriptor): void {
		if (!this._fields.has(name)) {
			this._fields.set(name, field);
			const property = fieldProperty(name, field);
			Object.defineProperty(this.prototype, name, property);
		}
	}

	addQueryParam(name: string, handler: QueryParamHandler): void {
		const handlers = this.queryParams.get(name);
		if (handlers === undefined)
			this.queryParams.set(name, [handler]);
		else
			handlers.push(handler);
	}

	addAttribute(name: string, descriptor: FieldDescriptor): void {
		this.addField(name, descriptor);
		this._attributes.add(name);
	}

	addRelation(name: string, relation: RelationDescriptor): void {
		if (!this._relations.has(name)) {
			this._relations.set(name, relation);
			this.addField(name, relationField(name));
		}
	}

	translateQuery(filter: object): object {
		const query: any = {};
		for (const name of Object.keys(filter)) {
			const handlers = this.queryParams.get(name);
			if (handlers !== undefined) {
				for (const translate of handlers)
					translate(filter, query);
			}
		}
		return query;
	}

	getInstanceField(instance: ModelInstance, data: object, name: string): MaybePromise<any> {
		const field = this._fields.get(name);
		if (field !== undefined && field.get !== undefined)
			return field.get.call(instance, data);
		return undefined;
	}

	setInstanceField(instance: ModelInstance, data: object, name: string, value: any): MaybePromise<void> {
		const field = this._fields.get(name);
		if (field !== undefined && field.set !== undefined)
			return field.set.call(instance, data, value);
	}

	boundRelation(instance: ModelInstance, data: object, name: string): Relation | undefined {
		const bindRelation = this._relations.get(name);
		if (bindRelation !== undefined)
			return bindRelation(instance, data);
		return undefined;
	}

	validateInstanceField(instance: ModelInstance, data: object, name: string, value: any): MaybePromise<ValidationResult> {
		const that = this;
		return maybeAsync(function*() {
			const field: FieldDescriptor = yield that._fields.get(name);
			if (field !== undefined && field.validators !== undefined) {
				type VR = ValidationResult;
				const results = field.validators.map((v: FieldValidator): MaybePromise<VR> => {
					return v.call(instance, data, value);
				});
				return new ValidationResult(yield results);
			}
			return new ValidationResult;
		});
	}

	select(fields: string[]): Model {
		const modelView = new Model(this.store, this);

		for (const name of fields) {
			const fieldDescriptor = this._fields.get(name);
			if (fieldDescriptor === undefined)
				continue;

			if (this._relations.has(name)) {
				const rd = this._relations.get(name);
				const relDescriptor = rd as RelationDescriptor;
				modelView.addRelation(name, relDescriptor);
			} else if (this._attributes.has(name)) {
				modelView.addAttribute(name, fieldDescriptor);
			} else {
				modelView.addField(name, fieldDescriptor);
			}
		}

		return modelView;
	}

	view(expr: string): Model {
		const scopeExpr = parse(expr);
		const info = scopeInfo(this._fields);
		const selected = scopeExpr(info, [...this.fields()]);
		return this.select(selected);
	}
}

export class ModelInstance {
	private _data: any = {};

	static wrap(model: Model, data: object): ModelInstance {
		const instance = new ModelInstance(model);
		instance._data = data;
		return instance;
	}

	constructor(private model: Model) {
		Object.setPrototypeOf(this, model.prototype);
	}

	get(name: string): MaybePromise<any> {
		return this.model.getInstanceField(this, this._data, name);
	}

	set(name: string, value: any): MaybePromise<void> {
		const that = this;
		return maybeAsync(function*() {
			const validationResult = yield that.validate(name, value);
			if (validationResult.hasErrors())
				throw new ValidationError(validationResult);
			return that.model.setInstanceField(that, that._data, name, value);
		});
	}

	getRelation(name: string): Relation | undefined {
		return this.model.boundRelation(this, this._data, name);
	}

	assign(data: object): MaybePromise<void> {
		const that = this;
		return maybeAsync(function*() {
			const entries = Object.entries(data).filter(([_, v]) => v !== undefined);
			return yield entries.map(([name, value]) => that.set(name, value));
		});
	}

	data(): MaybePromise<object> {
		const that = this;
		return maybeAsync(function*() {
			const data: any = {};
			const names = [...that.model.fields()];
			const values = yield names.map(name => that.get(name));
			for (let i = 0; i < values.length; ++i) {
				let value = values[i];
				if (value !== undefined) {
					const name = names[i];
					if (value.toJson !== undefined)
						value = value.toJson();
					data[name] = value;
				}
			}
			return data;
		});
	}

	enableValidation(): void {
		delete this.validate;
	}

	disableValidation(): void {
		this.validate = () => new ValidationResult;
	}

	validate(): MaybePromise<ValidationResult>;
	validate(data: object): MaybePromise<ValidationResult>;
	validate(name: string, value?: any): MaybePromise<ValidationResult>;
	validate(nameOrData?: object | string, value?: any): MaybePromise<ValidationResult> {
		const that = this;
		return maybeAsync(function*() {
			if (nameOrData === undefined) {
				return that.validate(yield this.data());
			} else if (typeof nameOrData !== 'string') {
				const data = nameOrData as any;
				const entries = Object.entries(data).filter(([_, v]) => v !== undefined);
				const results = entries.map(([name, value]) => that.validate(name, value));
				return new ValidationResult(yield results);
			} else {
				const name = nameOrData as string;
				if (value === undefined) value = yield that.get(name);
				return that.model.validateInstanceField(that, that._data, name, value);
			}
		});
	}
}

export interface QueryParamHandler {
	(query: object, output: object): void;
}

export interface FieldDescriptor {
	get?: FieldGetter;
	set?: FieldSetter;
	scopes?: string[];
	validators?: FieldValidator[];
}

export interface FieldGetter {
	(data: object): MaybePromise<any>;
}

export interface FieldSetter {
	(data: object, value: any): MaybePromise<void>;
}

export interface FieldValidator {
	(data: object, value: any): MaybePromise<ValidationResult>;
}

export interface RelationDescriptor {
	(that: ModelInstance, data: object): Relation;
}

export type ObjectRef = {
	type: string, id: ObjectId,
}

export type MultiRef  = ObjectRef[];
export type SingleRef = null | ObjectRef;

export type Relation = RelOne | RelMany;

export interface RelOne {
	ref(): MaybePromise<SingleRef>;

	get(): Promise<ModelInstance | null>;

	clear(): MaybePromise<void>;
	set(related: ModelInstance | null): MaybePromise<void>;
}

export interface RelMany {
	ref(): MaybePromise<MultiRef>;

	get(): Promise<ModelInstance[]>;

	clear(): MaybePromise<void>;
	set(related: ModelInstance[]): MaybePromise<void>;

	add(related: ModelInstance): MaybePromise<void>;
	remove(related: ModelInstance): MaybePromise<void>;
}

export class ValidationError extends Error {
	constructor(public result: ValidationResult) {
		super('Validation failed');
	}
}

export class ValidationResult {
	private _errors: Map<string, string[]> = new Map;

	constructor(results?: Iterable<ValidationResult>) {
		if (results !== undefined) {
			for (const res of results)
				this.merge(res);
		}
	}

	errors(): Iterable<[string, string]>;
	errors(field: string): Iterable<string>;
	*errors(field?: string): Iterable<string | [string, string]> {
		if (field === undefined) {
			for (const [field, errors] of this._errors) {
				for (const err of errors)
					yield [field, err];
			}
		} else {
			const errors = this._errors.get(field);
			if (errors !== undefined)
				yield* errors;
		}
	}

	hasErrors(field?: string): boolean {
		return field !== undefined
			? this._errors.has(field)
			: this._errors.size > 0;
	}

	addError(field: string, error: string): void {
		const errorBag = this._errors.get(field);
		if (errorBag === undefined)
			this._errors.set(field, [error]);
		else
			errorBag.push(error);
	}

	merge(result: ValidationResult): void {
		for (const [field, errors] of result._errors.entries()) {
			const errorBag = this._errors.get(field);
			if (errorBag === undefined)
				this._errors.set(field, [...errors]);
			else
				errorBag.push(...errors);
		}
	}
}

function fieldProperty(name: string, descriptor: FieldDescriptor): object {
	const result = {} as any;

	if (descriptor.get !== undefined) {
		result.get = function(): MaybePromise<any> {
			return this.get(name);
		};
	}

	if (descriptor.set !== undefined) {
		result.set = function(value: any): void {
			this.set(name, value);
		};
	}

	return result;
}

function relationField(name: string): FieldDescriptor {
	return {
		get(_: object): Relation {
			return this.getRelation(name);
		},

		set(_: object, value: any): MaybePromise<void> {
			const relation = this.getRelation(name);
			if (relation !== undefined)
				return relation.set(value);
		},
	};
}

function scopeInfo(fields: Map<string, FieldDescriptor>): ScopeInfo {
	const scopeInfo: any = {};
	fields.forEach((descriptor: FieldDescriptor, name: string) => {
		scopeInfo[name] = descriptor.scopes || [];
	});
	return scopeInfo;
}
