import { ChatItem, ItemData } from './ChatItem';
import { UIDHelper } from './UIDHelper';

//max number of items we keep in cache
const MAX_LOAD = 65;

//items we load in each batch
const BATCH_SIZE = 30;

export enum LoadDirection {
	DOWN = -1,
	NONE = 0,
	UP = 1,
}
export enum ChangeOperation {
	REMOVE_UP = 'REMOVE_UP',
	REMOVE_DOWN = 'REMOVE_DOWN',
	NONE = 'NONE',
	ADD_DOWN = 'ADD_DOWN',
	ADD_UP = 'ADD_UP',
}

export type SearchQuery = {
	skip?: number;
	limit: number;
	_created_date?: { $lte?: Date; $gte?: Date };
	sort?: any;
	exclude?: any[];
};
export type LoadFunctionType = (props: SearchQuery) => Promise<ItemData[]> | ItemData[];
export type RefreshFunctionType = () => any;

type SetItemsFunctionType = (items: ChatItem[]) => any;

export class ChatManager {
	static WRAPPER_HEIGHT = 400;
	static WRAPPER_BUFFER_HEIGHT = ChatManager.WRAPPER_HEIGHT + 200;

	//we update scroll positions relative to this item to prevent the scroll from jumping
	private referenceItem: ChatItem | undefined;

	private currentItems: ChatItem[] = [];
	private currentItemsMap: { [key: string]: ChatItem } = {};

	private isLastLoadFromDB: boolean = true;
	public isSticky: boolean = true;
	// public scrollPercent: number = 0;
	public distanceToTop: number = 0;
	public distanceToBottom: number = 0;

	#lastLoadDirection: LoadDirection = LoadDirection.NONE;
	#lastOperation: ChangeOperation = ChangeOperation.NONE;
	#lastCountChange: number = 0;
	#lastDBLoad: number = 0;

	private currentLoadOperation?: any;

	private setItemsFunction?: SetItemsFunctionType;

	private loadFunction?: LoadFunctionType;
	private refreshFunction?: RefreshFunctionType;

	private lastCount: number = 0;

	private id_veryTopMessage?: any;
	private id_veryBottomMessage?: any;

	constructor() {}

	set_loadFunction(fnc: LoadFunctionType) {
		this.loadFunction = fnc;
	}
	set_refreshFunction(fnc: RefreshFunctionType) {
		this.refreshFunction = fnc;
	}
	set_setItemsFunction(fnc: SetItemsFunctionType) {
		this.setItemsFunction = fnc;
	}

	/**
	 * delete the given message from the list
	 * @param msg
	 */
	async deleteMessage(msg: ChatItem | ItemData) {
		const msgid = msg instanceof ChatItem ? msg.itemid : msg._id;
		const messagesToDelete = this.currentItemsMap[msgid];
		if (messagesToDelete) {
			const rmIndex = this.currentItems.findIndex((s) => s === messagesToDelete);
			//
			const newArr = [...this.currentItems];
			newArr.splice(rmIndex, 1);
			await this.setItems(newArr);
		}
	}
	/**
	 * add a new message to the bottom of the list
	 * @param msglist
	 * @returns if the message was added
	 */
	async sendNewMessage(...msglist: Array<ChatItem | any>): Promise<boolean> {
		const messagesToAdd = msglist
			.flat()
			.filter((s) => s)
			.map((r: any) => (r instanceof ChatItem ? r : new ChatItem(this, r)));

		//make sure the messages are not already loaded :
		const newMessagesToAdd = messagesToAdd.filter(
			(s) => this.currentItemsMap[s.itemid] == null
		);

		if (newMessagesToAdd.length === 0) return false;
		if (this.isAtBottom) {
			//we are at the bottom of the list, new messages should be added

			// console.log('add Message:', messagesToAdd);
			const addCount = await this.add_items_to_list(
				newMessagesToAdd,
				LoadDirection.DOWN,
				false
			);
			//if a new message is added the bottom message must change:
			this.updateBottomMessage();
			return addCount > 0;
		}
		return false;
	}

	/**
	 * load the next batch of items when previous load is finished
	 * @param direction
	 * @returns
	 */
	async loadIfNeeded() {
		let loadDir = LoadDirection.NONE;
		if (this.shouldLoadTop) loadDir = LoadDirection.UP;
		else if (this.shouldLoadDown) loadDir = LoadDirection.DOWN;
		else return;

		if (this.currentLoadOperation != null) await this.currentLoadOperation;
		this.currentLoadOperation = this.load_items(loadDir);
		return await this.currentLoadOperation;
	}
	async loadForNewMessages() {
		this.id_veryBottomMessage = null;
		await this.loadIfNeeded();
	}

	/**
	 * load more items in the given direction
	 * @param direction
	 */
	private async load_items(direction: LoadDirection = LoadDirection.UP) {
		if (!this.loadFunction) return;

		const search_query: SearchQuery = {
			limit: BATCH_SIZE,
		};

		if (direction == LoadDirection.DOWN) {
			search_query.sort = { _created_date: 1 };
			if (this.bottomMessage?._created_date)
				search_query._created_date = { $gte: this.bottomMessage?._created_date };
		} else {
			search_query.sort = { _created_date: -1 };
			if (this.topMessage?._created_date)
				search_query._created_date = { $lte: this.topMessage?._created_date };
		}
		search_query.exclude = this.currentItems.map((r) => r.itemid);

		this.#lastLoadDirection = direction;

		//

		const loaded_items = await this.loadFunction(search_query);

		//
		this.#lastDBLoad = loaded_items.length;

		/* ------------------------ convert items to ChatItem ----------------------- */
		let final_chats = loaded_items
			.map((r, i) => new ChatItem(this, r))
			/* -------- first sort in inverse so we can assign Indexes correctly -------- */
			.sort((a, b) => b._created_time - a._created_time);

		/* ------------------------------ apply indexes ----------------------------- */

		/* -------------------- then reverse and add to the list -------------------- */
		final_chats = final_chats.reverse();
		await this.add_items_to_list(final_chats, direction, true);
	}

	private async add_items_to_list(
		items_to_add: ChatItem[],
		direction: LoadDirection = LoadDirection.UP,
		isFromDB: boolean = true
	): Promise<number> {
		this.#lastOperation =
			direction === LoadDirection.UP ? ChangeOperation.ADD_UP : ChangeOperation.ADD_DOWN;

		this.isLastLoadFromDB = isFromDB;

		const nextItems = [...this.currentItems];
		if (direction === LoadDirection.UP) {
			//add above the list
			nextItems.unshift(...items_to_add);
		} else {
			//add below the list
			nextItems.push(...items_to_add);
		}
		await this.setItems(nextItems);
		return items_to_add.length;
	}

	private async setItems(items: ChatItem[]): Promise<number> {
		this.before_update();
		this.currentItems = this.cleanExtraItems(items);

		//set the item map
		this.currentItemsMap = {};
		this.currentItems.forEach((r) => (this.currentItemsMap[r.itemid] = r));

		this.#lastCountChange = items.length - this.lastCount;
		this.lastCount = this.currentItems.length;
		//console.log('setitems', this.currentItems);
		this.check_position();
		this.update_next_prev_items();

		if (this.setItemsFunction) await this.setItemsFunction(this.currentItems);
		return this.currentItems.length;
	}

	/**
	 * clear items in the given list to match the max item count
	 */
	private cleanExtraItems(inputItems: ChatItem[]): ChatItem[] {
		if (inputItems.length <= MAX_LOAD) return inputItems;
		let countToRemove = MAX_LOAD - inputItems.length + 10;

		let dirToRemove = LoadDirection.NONE;

		if (this.lastLoadDirection === LoadDirection.UP && !this.isCloseToBottom) {
			dirToRemove = LoadDirection.DOWN;
		} else if (this.lastLoadDirection === LoadDirection.DOWN && !this.isCloseToTop) {
			dirToRemove = LoadDirection.UP;
		}

		countToRemove = Math.min(Math.abs(countToRemove), inputItems.length);
		if (countToRemove === 0 || dirToRemove === LoadDirection.NONE) return inputItems;

		let resultItems = [...inputItems];
		//
		if (dirToRemove === LoadDirection.UP) {
			//remove from top
			resultItems.splice(0, countToRemove);
		} else if (dirToRemove === LoadDirection.DOWN) {
			const rmStartIndex = Math.max(resultItems.length - countToRemove, 0);
			resultItems.splice(rmStartIndex);
		}
		return resultItems;
	}

	private update_next_prev_items() {
		const maxindex = this.currentItems.length - 1;
		this.currentItems.map((r, i) => {
			r.nextitem = i != maxindex ? this.currentItems[i + 1] : undefined;
			r.previtem = i != 0 ? this.currentItems[i - 1] : undefined;
		});

		// let breakNextLoop = false;
		// if (this.lastOperation === ChangeOperation.ADD_UP)
		// 	for (let i = 0; i < this.currentItems.length; i++) {
		// 		if (breakNextLoop) break;
		// 		const r = this.currentItems[i];
		// 		if (r.nextitem && r.previtem) breakNextLoop = true;
		//
		// 		r.nextitem = i != maxindex ? this.currentItems[i + 1] : undefined;
		// 		r.previtem = i != 0 ? this.currentItems[i - 1] : undefined;
		// 	}
		// else if(this.lastOperation === ChangeOperation.ADD_DOWN)
		// 	for (let i = this.currentItems.length - 1; i >= 0; i--) {
		// 		if (breakNextLoop) break;
		// 		const r = this.currentItems[i];
		// 		if (r.nextitem && r.previtem) breakNextLoop = true;
		//
		// 		r.nextitem = i != maxindex ? this.currentItems[i + 1] : undefined;
		// 		r.previtem = i != 0 ? this.currentItems[i - 1] : undefined;
		// 	}
	}

	private before_update() {
		//set reference to an item that is in view
		//we do this to make sure our reference item doesnt get unloaded
		if (this.lastLoadDirection === LoadDirection.UP) {
			this.referenceItem = this.topMessage;
		} else if (this.lastLoadDirection === LoadDirection.DOWN) {
			this.referenceItem = this.bottomMessage;
		}
		this.referenceItem?.savePosition();
	}
	/**
	 * check if we reached the bottom or top of the list
	 */
	private check_position() {
		if (!this.isLastLoadFromDB) {
			this.updateBottomMessage();
			return;
		}

		/* -------------------------------------------------------------------------- */
		/*                          Loading Something from DB                         */
		/* -------------------------------------------------------------------------- */

		if (!this.id_veryBottomMessage) {
			//if bottom message is not set yet (first load), set it to the current bottom item
			//if the bottom message id is -1 this will not run !
			this.updateBottomMessage();
		}

		/* ---------------- loading less than limit means end of chat --------------- */
		//we load less items than limit -> we have reached the top/bottom of the chat
		if (this.#lastDBLoad < BATCH_SIZE) {
			//console.log('loaded less items than expected. updating max/min');
			if (this.lastLoadDirection === LoadDirection.DOWN) this.updateBottomMessage();
			else if (this.lastLoadDirection === LoadDirection.UP)
				this.id_veryTopMessage = this.topMessage?.itemid;
		} else {
			// clear top/bot if we are in middle of the list
			// so we can correctly detect new messages that are added below the veryBottomMessage
			if (this.id_veryBottomMessage != this.bottomMessage?.itemid) {
				this.id_veryBottomMessage = -1;
			}
			if (this.id_veryTopMessage != this.topMessage?.itemid) {
				this.id_veryTopMessage = -1;
			}
		}
	}
	private updateBottomMessage() {
		this.id_veryBottomMessage = this.bottomMessage?.itemid;
	}
	/* --------------------------------- getters -------------------------------- */
	get topMessageDate(): number | undefined {
		return this.topMessage?._created_time ?? undefined;
	}
	get bottomMessageDate(): number | undefined {
		return this.bottomMessage?._created_time ?? undefined;
	}

	get topMessage(): ChatItem | undefined {
		if (this.currentItems.length === 0) return undefined;
		return this.currentItems[0];
	}
	get middleMessage(): ChatItem | undefined {
		if (this.currentItems.length === 0) return undefined;
		return this.currentItems[Math.ceil(this.currentItems.length / 2)];
	}
	get bottomMessage(): ChatItem | undefined {
		if (this.currentItems.length === 0) return undefined;
		return this.currentItems[this.currentItems.length - 1];
	}

	get referenceTop(): number {
		return this.referenceItem?.topDistance || Number.NaN;
	}
	get referenceLastTop(): number {
		return this.referenceItem?.lastTop || Number.NaN;
	}
	get isAtTop() {
		return this.topMessage != null && this.topMessage.itemid === this.id_veryTopMessage;
	}
	get isAtBottom() {
		return (
			this.bottomMessage == null ||
			this.bottomMessage.itemid === this.id_veryBottomMessage
		);
	}

	get isCloseToTop() {
		return this.distanceToTop < ChatManager.WRAPPER_BUFFER_HEIGHT;
	}
	get isCloseToBottom() {
		return this.distanceToBottom < ChatManager.WRAPPER_BUFFER_HEIGHT;
	}

	get shouldLoadTop() {
		return this.isCloseToTop && !this.isAtTop;
	}
	get shouldLoadDown() {
		return this.isCloseToBottom && !this.isAtBottom;
	}

	/* number of changed items in the last load */
	get itemCount() {
		return this.currentItems.length;
	}
	get lastCountChange() {
		return this.#lastCountChange;
	}
	get lastDBLoad() {
		return this.#lastDBLoad;
	}
	get lastLoadDirection(): LoadDirection {
		return this.#lastLoadDirection;
	}

	get lastOperation(): ChangeOperation {
		return this.#lastOperation;
	}
}
export default ChatManager;
