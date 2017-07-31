export interface ScopeInfo {
	[field: string]: string[];
}

export interface ScopeExpr {
	(info: ScopeInfo, fields: string[]): string[];
}

export class ParseError extends Error {
	constructor(message?: string) {
		super(message);
	}
}

export function parse(expr: string): ScopeExpr {
	const tokens = tokenize(expr);
	const steps = applyPrecedence(tokens);
	return prepareExpr(steps);
}

function tokenize(expr: string): string[] {
	return expr.split(/([()|&!])/).map(x => x.trim()).filter(x => x);
}

type ScopeOp = '!' | '&' | '|';

function opPrecedence(op: ScopeOp): number {
	switch (op) {
		case '|': return 1;
		case '&': return 2;
		case '!': return 3;
	}
}

function applyPrecedence(tokens: string[]): string[] {
	const opStack: string[] = [];
	const outputStack: string[] = [];
	for (const current of tokens) {
		switch (current) {
		case '|': case '&': case '!':
			const precedence = opPrecedence(current);
			while (opStack.length > 0) {
				const opStackTop = opStack[opStack.length - 1];
				if (opStackTop == '(')
					break;
				if (opPrecedence(opStackTop as ScopeOp) < precedence)
					break;
				outputStack.push(opStack.pop() as string);
			}
			opStack.push(current);
			break;
		case '(':
			opStack.push('(');
			break;
		case ')':
			while (opStack.length > 0 && opStack[opStack.length - 1] !== '(')
				outputStack.push(opStack.pop() as string);
			opStack.pop();
			break;
		default:
			outputStack.push(current);
			break;
		}
	}
	if (opStack.includes('('))
		throw new ParseError;
	outputStack.push(...opStack);
	return outputStack;
}

function prepareExpr(steps: string[]): ScopeExpr {
	const stack: ScopeExpr[] = [];
	for (const s of steps) {
		switch (s) {
		case '|':
			if (stack.length < 2)
				throw new ParseError;
			var left = stack.pop() as ScopeExpr;
			var right = stack.pop() as ScopeExpr;
			stack.push(scopeJoin(left, right));
			break;
		case '&':
			if (stack.length < 2)
				throw new ParseError;
			var left = stack.pop() as ScopeExpr;
			var right = stack.pop() as ScopeExpr;
			stack.push(scopeIntersect(left, right));
			break;
		case '!':
			if (stack.length < 1)
				throw new ParseError;
			var subexpr = stack.pop() as ScopeExpr;
			stack.push(scopeNegate(subexpr));
			break;
		case '*':
			stack.push(scopeWildcard);
			break;
		default:
			stack.push(scopeLiteral(s));
			break;
		}
	}
	return stack.pop() as ScopeExpr;
}

function scopeWildcard(_: ScopeInfo, fields: string[]): string[] {
	return fields;
}

function scopeLiteral(scope: string): ScopeExpr {
	return (info: ScopeInfo, fields: string[]): string[] => {
		return fields.filter(f => info[f].includes(scope));
	};
}

function scopeNegate(subexpr: ScopeExpr): ScopeExpr {
	return (info: ScopeInfo, fields: string[]): string[] => {
		const excludedFields: string[] = subexpr(info, fields);
		return fields.filter(f => !excludedFields.includes(f));
	};
}

function scopeJoin(left: ScopeExpr, right: ScopeExpr): ScopeExpr {
	return (info: ScopeInfo, fields: string[]): string[] => {
		const allFields = [...left(info, fields), ...right(info, fields)];
		return Array.from((new Set(allFields)).values());
	};
}

function scopeIntersect(left: ScopeExpr, right: ScopeExpr): ScopeExpr {
	return (info: ScopeInfo, fields: string[]): string[] => {
		const includedFields = right(info, fields);
		return left(info, fields).filter(f => {
			return includedFields.includes(f);
		});
	};
}
