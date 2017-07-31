export type ObjectId = any;

export interface Store {
	findOne(filter: object, opts: QueryOptions): Promise<any>;
	findMany(filter: object, opts: QueryOptions): Promise<any[]>;

	insertOne(item: object): Promise<ObjectId>;
	insertMany(items: object[]): Promise<ObjectId[]>;

	updateOne(filter: object, update: any): Promise<UpdateResult>;
	updateMany(filter: object, update: any): Promise<UpdateResult>;

	deleteOne(filter: object): Promise<DeleteResult>;
	deleteMany(filter: object): Promise<DeleteResult>;
}

export interface Ordering {
	[index: string]: number
};

export interface QueryOptions {
	limit?: number;
	offset?: number;
	select?: string[];
	orderBy?: Ordering;
}

export class UpdateResult {
	matchedCount: number;
	modifiedCount: number;
}

export class DeleteResult {
	deletedCount: number;
}
