import { addRxPlugin, createRxDatabase, lastOfArray, deepEqual } from "skypack:rxdb";

import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";


const EPOCH = new Date();

addRxPlugin(RxDBDevModePlugin);

class Chat extends EventTarget {
    db;

    #state = { replications: {}, canonicalDocumentChanges: {} };

    constructor ({ db }) {
        this.db = db;
    }

    static async init() {
        const db = await createRxDatabase({
            name: "chat",
            storage: getRxStorageMemory(),
            eventReduce: true,
            multiInstance: false, // Change this when ported to web etc.
        });

        // Invoke the private constructor...
        return new Chat({ db });
    }
}

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

                            const data = await resp.json();

                            if (!resp.ok) {
                                 if (data.error.code === 'context_length_exceeded') {
                                    
                                 }

                                throw new Error(data.error.message);
                            }

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
                                docData.failureMessages = docData.failureMessages.concat(error);
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
window.chat = await Chat.init()
window.conflictHandler = conflictHandler;
window.createCollectionsFromCanonical = createCollectionsFromCanonical;
window.syncDocsFromCanonical = syncDocsFromCanonical;
window.finishedSyncingDocsFromCanonical = finishedSyncingDocsFromCanonical;

// Debug.
window._db = db;
window._state = state;


