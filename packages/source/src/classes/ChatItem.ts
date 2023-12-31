import { Ref } from 'react';
import { UIDHelper } from './UIDHelper';
import ChatManager from './ChatManager';

export type ItemData = any;
export class ChatItem {
	readonly key: string;
	readonly itemid: string;
	readonly data: ItemData;
	readonly _created_date: Date;
	readonly _created_time: number;
	readonly managerClass: ChatManager;

	private __options: any = {};

	public previtem?: ChatItem;
	public nextitem?: ChatItem;

	public isNew: boolean = false;
	public itemref?: React.MutableRefObject<any>;

	constructor(mng: ChatManager, d: ItemData) {
		//set the data
		this.managerClass = mng;
		this.data = d;

		//get the id from data
		this.itemid = ChatItem.getObjectId(this.data) || UIDHelper.nextid();
		this.key = String(this.itemid);

		//assign the date
		this._created_date = ChatItem.getObjectDate(this.data);
		this._created_time = this._created_date.getTime();
	}

	savePosition() {
		this.__options['lasttop'] = this.topDistance;
	}
	async deleteFromList() {
		console.log('deleteFromList');
		return await this.managerClass.deleteMessage(this);
	}

	get topDistance() {
		return this.itemref?.current?.getBoundingClientRect().top || 0;
	}
	get lastTop() {
		return this.__options['lasttop'] || Number.NaN;
	}
	static getObjectId(inp: any) {
		return inp._id ?? inp.id;
	}
	static getObjectDate(inp: any) {
		let controlObject = inp;
		if (controlObject)
			try {
				return new Date(controlObject.date || controlObject._created_date);
			} catch {}

		return new Date();
	}
}
