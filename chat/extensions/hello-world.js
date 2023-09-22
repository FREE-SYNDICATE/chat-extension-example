import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "skypack:rxdb";

import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";

// Console proxy, modified from livecodes
// typeOf modified from https://github.com/alexindigo/precise-typeof/blob/master/index.js
const typeOf = (obj) => {
    function isElement(o) {
        return typeof HTMLElement === 'object'
            ? o instanceof HTMLElement
            : o &&
            typeof o === 'object' &&
            o !== null &&
            o.nodeType === 1 &&
            typeof o.nodeName === 'string';
    }
    function isNode(o) {
        return typeof Node === 'object'
            ? o instanceof Node
            : o &&
            typeof o === 'object' &&
            typeof o.nodeType === 'number' &&
            typeof o.nodeName === 'string';
    }
    function isDocument(o) {
        return Object.prototype.toString.call(o) === '[object HTMLDocument]';
    }
    function isWindow(o) {
        return Object.prototype.toString.call(o) === '[object Window]';
    }

    const stamp = Object.prototype.toString.call(obj);

    if (obj === undefined) return 'undefined';
    if (obj === null) return 'null';

    if (isWindow(obj)) return 'window';
    if (isDocument(obj)) return 'document';
    if (isElement(obj)) return 'element';
    if (isNode(obj)) return 'node';

    if (
        obj.constructor &&
        typeof obj.constructor.isBuffer === 'function' &&
        obj.constructor.isBuffer(obj)
    ) {
        return 'buffer';
    }

    if (typeof window === 'object' && obj === window) return 'window';
    if (typeof global === 'object' && obj === global) return 'global';

    if (typeof obj === 'number' && isNaN(obj)) return 'nan';
    if (typeof obj === 'object' && stamp === '[object Number]' && isNaN(obj)) return 'nan';

    if (typeof obj === 'object' && stamp.substr(-6) === 'Event]') return 'event';
    if (stamp.substr(0, 12) === '[object HTML') return 'element';
    if (stamp.substr(0, 12) === '[object Node') return 'node';

    // last resort
    const type = stamp.match(/\[object\s*([^\]]+)\]/);
    if (type) return type[1].toLowerCase();

    return 'object';
};
function consoleArgs(args) {
    return args.map((arg) => {
        switch (typeOf(arg)) {
            case 'window':
            case 'function':
            case 'date':
            case 'symbol':
                return { type: typeOf(arg), content: arg.toString() };
            case 'document':
                return { type: typeOf(arg), content: arg.documentElement.outerHTML };
            case 'element':
                return { type: typeOf(arg), content: arg.outerHTML };
            case 'node':
                return { type: typeOf(arg), content: arg.textContent };
            case 'array':
                return { type: typeOf(arg), content: arg.map((x) => consoleArgs([x])[0].content) };
            case 'object':
                return {
                    type: typeOf(arg),
                    content: Object.keys(arg).reduce(
                        (acc, key) => ({ ...acc, [key]: consoleArgs([arg[key]])[0].content }),
                        {},
                    ),
                };
            case 'error':
                return {
                    type: typeOf(arg),
                    content: arg.constructor.name + ': ' + arg.message,
                };
        }
        try {
            return { type: 'other', content: structuredClone(arg) };
        } catch {
            return { type: 'other', content: String(arg) };
        }
    });
};
const proxyConsole = () => {
    window.console = new Proxy(console, {
        get(target, method) {
            return function (...args) {
                if (!(method in target)) {
                    const msg = `Uncaught TypeError: console.${String(method)} is not a function`;
                    target.error(msg);
                    window.webkit.messageHandlers.consoleMessage.postMessage({ method: 'error', args: consoleArgs([msg]) });
                    return;
                }
                (target[method])(...args);
                window.webkit.messageHandlers.consoleMessage.postMessage({ method, args: consoleArgs(args) });
            };
        },
    });

    window.addEventListener('error', (error) => {
        window.webkit.messageHandlers.consoleMessage.postMessage({ method: 'error', args: consoleArgs([error.message]) });
    });
};
proxyConsole();


const EPOCH = new Date();

addRxPlugin(RxDBDevModePlugin);

const ChatOnMacPlugin = {
    name: "chatonmac",
    rxdb: true,
    hooks: {
        createRxCollection: {
            after: async (args) => {
                const db = args.collection.database;
                const collection = args.collection;

                if (collection.name === "event") {
                    collection.insert$.subscribe(async ({ documentData, collectionName }) => {
                        if (documentData.createdAt < EPOCH.getTime()) {
                            return;
                        }
                        const personaCollection = db.collections["persona"];
                        const persona = await personaCollection
                            .findOne({
                                selector: { id: documentData.sender },
                            })
                            .exec();
                        if (persona?.personaType !== "user") {
                            return;
                        }

                        // Build message history.
                        const messages = await collection
                            .find({
                                selector: {
                                    room: documentData.room,
                                },
                                limit: 10, // TODO: This is constrained by the model's token limit.
                                sort: [{ createdAt: "desc" }],
                            })
                            .exec();

                        const messageHistory = await Promise.all(
                            messages.map(async ({ content, persona }) => {
                                const foundPersona = await personaCollection
                                    .findOne({ selector: { id: persona } })
                                    .exec();
                                return {
                                    role:
                                    foundPersona.personaType === "bot" ? "assistant" : "user",
                                    content,
                                };
                            })
                        );
                        messageHistory.sort((a, b) => b - a);
                        const room = await db.collections["room"].findOne(documentData.room).exec();
                        const botPersonas = await getBotPersonas(room);
                        const botPersona = botPersonas.length ? botPersonas[0] : null;
                        if (!botPersona) {
                            console.log("No matching bot to emit from.")
                            return;
                        }

                        if (!botPersona.selectedModel) {
                            botPersona.selectedModel = botPersona.modelOptions[0];
                        }

                        var systemPrompt = "";
                        if (botPersona.customInstructionForContext || botPersona.customInstructionForReplies) {
                            if (botPersona.customInstructionForContext) {
                                systemPrompt += botPersona.customInstructionForContext.trim() + "\n\n"
                            }
                            if (botPersona.customInstructionForResponses) {
                                systemPrompt += botPersona.customInstructionForResponses.trim() + "\n\n"
                            }
                        } else {
                            systemPrompt = "You are a helpful assistant.";
                        }
                        systemPrompt = systemPrompt.trim();

                        try {
                            const resp = await fetch(
                                "code://code/load/api.openai.com/v1/chat/completions",
                                {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                        "X-Chat-Trace-Event": documentData.id,
                                    },
                                    body: JSON.stringify({
                                        model: botPersona.selectedModel,
                                        temperature: botPersona.modelTemperature,
                                        messages: [
                                            {
                                                role: "system",
                                                content: systemPrompt,
                                            },
                                            ...messageHistory,
                                            {
                                                role: "user",
                                                content: documentData.content,
                                            },
                                        ],
                                    }),
                                }
                            );

                            if (!resp.ok) {
                                throw new Error(resp.message);
                            }

                            const data = await resp.json();

                            const content = data.choices[0].message.content;
                            const createdAt = new Date().getTime();

                            collection.insert({
                                id: crypto.randomUUID(),
                                content,
                                type: "message",
                                room: documentData.room,
                                sender: botPersona.id,
                                createdAt,
                                modifiedAt: createdAt,
                            });
                        } catch (error) {
                            var eventDoc = await db.collections["event"].findOne(documentData.id).exec();
                            await eventDoc.incrementalModify((docData) => {
                                docData.failureMessages = docData.failureMessages.concat(error.message);
                                docData.retryablePersonaFailures = docData.retryablePersonaFailures.concat(botPersona.id);
                                return docData;
                            });
    /*for (const replicationState of Object.values(state.replications)) {
        replicationState.reSync();
        await replicationState.awaitInSync();
    }*/
                        }
                    });
                }
            },
        },
    },
};

addRxPlugin(ChatOnMacPlugin);

const db = await createRxDatabase({
    name: "database", // TODO: Does this matter?
    storage: getRxStorageMemory(),
    eventReduce: true,
    multiInstance: false, // Change this when ported to web or etc.
});

const state = { replications: {}, canonicalDocumentChanges: {} };

function getReplicationStateKey(collectionName) {
    return `${collectionName}ReplicationState`;
}

function getCanonicalDocumentChangesKey(collectionName) {
    return `${collectionName}CanonicalDocumentChanges`;
}

async function createCollectionsFromCanonical(collections) {
    for (const [collectionName, collection] of Object.entries(collections)) {
        collections[collectionName]["conflictHandler"] = window.conflictHandler;
    }

    await db.addCollections(collections);

    const collectionEntries = Object.entries(db.collections);
    for (const [collectionName, collection] of collectionEntries) {
        const replicationState = await createReplicationState(collection);
        const replicationStateKey = getReplicationStateKey(collectionName);
        state.replications[replicationStateKey] = replicationState;
    }

    for (const replicationState of Object.values(state.replications)) {
        replicationState.reSync();
        await replicationState.awaitInSync();
    }
}

async function createReplicationState(collection) {
    const { name: collectionName } = collection;

    const replicationState = replicateRxCollection({
        collection,
        replicationIdentifier: `${collectionName}-replication`,
        live: true,
        retryTime: 5 * 1000,
        waitForLeadership: true,
        autoStart: true,

        deletedField: "isDeleted",

        push: {
            async handler(docs) {
                //console.log("Called push handler with: ", docs);
                window.webkit.messageHandlers.surrogateDocumentChanges.postMessage({
                    collectionName: collection.name,
                    changedDocs: docs.map((row) => {
                        return row.newDocumentState;
                    }),
                });

                return [];
            },

            batchSize: 50,
            modifier: (doc) => doc,
        },

        pull: {
            async handler(lastCheckpoint, batchSize) {
                //console.log("Called pull handler with: ", lastCheckpoint, batchSize);

                const canonicalDocumentChangesKey =
                    getCanonicalDocumentChangesKey(collectionName);
                var documents = [];
                for (let i = 0; i < batchSize; i++) {
                    const el = (state.canonicalDocumentChanges[canonicalDocumentChangesKey] || []).shift();
                    if (el) {
                        documents.push(el);
                    } else {
                        break;
                    }
                }

                const checkpoint =
                    documents.length === 0
                    ? lastCheckpoint
                    : {
                        id: lastOfArray(documents).id,
                        modifiedAt: lastOfArray(documents).modifiedAt,
                    };

                window[`${collectionName}LastCheckpoint`] = checkpoint;

                return {
                    documents,
                    checkpoint,
                };
            },

            batchSize: 10,
            modifier: (doc) => doc,
        },
    });

    return replicationState;
}

async function syncDocsFromCanonical(collectionName, changedDocs) {
    const replicationStateKey = getReplicationStateKey(collectionName);
    const replicationState = state.replications[replicationStateKey];

    const canonicalDocumentChangesKey =
        getCanonicalDocumentChangesKey(collectionName);

    if (!state.canonicalDocumentChanges[canonicalDocumentChangesKey]) {
        state.canonicalDocumentChanges[canonicalDocumentChangesKey] = [];
    }
    state.canonicalDocumentChanges[canonicalDocumentChangesKey].push(...changedDocs);

    replicationState.reSync();
    await replicationState.awaitInSync();
}

async function finishedSyncingDocsFromCanonical() {
    console.log("finishedSyncingDocsFromCan()")
    for (const replicationState of Object.values(state.replications)) {
        replicationState.reSync();
        await replicationState.awaitInSync();
    }

    // TODO: Multiple bots.
    const botPersonas = await getBotPersonas(null);
    for (const botPersona of botPersonas) {
        if (!botPersona.online) {
            // Refresh instance (somehow stale otherwise).
            let bot = await db.collections["persona"].findOne(botPersona.id).exec();
            await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
        }
        botPersona.online$.subscribe(async online => {
            if (!online) {
                // Refresh instance (somehow stale otherwise).
                let bot = await db.collections["persona"].findOne(botPersona.id).exec();
                await bot.incrementalPatch({ online: true, modifiedAt: new Date().getTime() });
            }
        });
    }
}

async function getProvidedBotsIn(extension, room) {
    var bots = [];
    if (room && room.participants && room.participants.length > 0) {
        let allInRoomMap = await db.collections["persona"].findByIds(room.participants).exec();
        for (const participant of allInRoomMap.values()) {
            if (participant.providedByExtension === extension.id && participant.personaType === "bot") {
                bots.push(participant);
            }
        }
    }
    return bots;
}

async function getBotPersonas(room) {
    let extension = await db.collections["code_extension"].findOne().exec();
    let botPersonas = await getProvidedBotsIn(extension, room);
    if (botPersonas.length > 0) {
        return botPersonas;
    }

    let allRooms = await db.collections["room"].find().exec();
    var bots = [];
    for (const otherRoom of allRooms) {
        botPersonas = await getProvidedBotsIn(extension, otherRoom);
        if (botPersonas.length > 0) {
            bots.push(...botPersonas);
        }
    }
    if (bots.length > 0) {
        return bots;
    }

    let botPersona = await db.collections["persona"]
        .findOne({ selector: { personaType: "bot" } })
        .exec();
    if (!botPersona) {
        botPersona = await db.collections["persona"].insert({
            id: crypto.randomUUID(),
            name: "ChatBOT",
            personaType: "bot",
            online: true,
            modelOptions: ["gpt-3.5-turbo", "gpt-4"],
            modifiedAt: new Date().getTime(),
        });
    }
    return [botPersona];
}

/**
 * The conflict handler gets 3 input properties:
 * - assumedMasterState: The state of the document that is assumed to be on the master branch
 * - newDocumentState: The new document state of the fork branch (=client) that RxDB want to write to the master
 * - realMasterState: The real master state of the document
 */
function conflictHandler(i) {
    /**
     * Here we detect if a conflict exists in the first place.
     * If there is no conflict, we return isEqual=true.
     * If there is a conflict, return isEqual=false.
     * In the default handler we do a deepEqual check,
     * but in your custom conflict handler you probably want
     * to compare specific properties of the document, like the updatedAt time,
     * for better performance because deepEqual() is expensive.
     */
    if (deepEqual(
        i.newDocumentState,
        i.realMasterState
    )) {
        return Promise.resolve({
            isEqual: true
        });
    }

    /**
     * If a conflict exists, we have to resolve it.
     * The default conflict handler will always
     * drop the fork state and use the master state instead.
     * 
     * In your custom conflict handler you likely want to merge properties
     * of the realMasterState and the newDocumentState instead.
     */
    return Promise.resolve({
        isEqual: false,
        documentData: i.newDocumentState.modifiedAt > i.realMasterState.modifiedAt ? i.realMasterState : i.newDocumentState,
    });
}

// Public API.
window.conflictHandler = conflictHandler;
window.createCollectionsFromCanonical = createCollectionsFromCanonical;
window.syncDocsFromCanonical = syncDocsFromCanonical;
window.finishedSyncingDocsFromCanonical = finishedSyncingDocsFromCanonical;

// Debug.
window._db = db;
window._state = state;

