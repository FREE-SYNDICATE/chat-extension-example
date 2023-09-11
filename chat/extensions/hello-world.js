import { addRxPlugin, createRxDatabase, lastOfArray } from "skypack:rxdb";

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

let persona;

const ChatOnMacPlugin = {
  name: "chatonmac",
  rxdb: true,
  hooks: {
    createRxCollection: {
      after: async (args) => {
        const db = args.collection.database;
        const collection = args.collection;

        if (collection.name === "event") {
          collection.$.subscribe(async ({ documentData, collectionName }) => {
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

            // TODO: Error handling.
            const resp = await fetch(
              "code://code/load/api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "gpt-3.5-turbo",
                  messages: [
                    {
                      role: "system",
                      content: "You are a helpful assistant.",
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

            const content = data.choices[0].message.content;
            const createdAt = new Date().getTime();

            // TODO: Multiple bots.
            const botPersona = await personaCollection
              .findOne({ selector: { personaType: "bot" } })
              .exec();

            collection.insert({
              id: crypto.randomUUID(),
              content,
              type: "message",
              room: documentData.room,
              sender: botPersona.id,
              createdAt,
              modifiedAt: createdAt,
            });
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
});

const state = { replications: {}, canonicalDocumentChanges: {} };

function getReplicationStateKey(collectionName) {
  return `${collectionName}ReplicationState`;
}

function getCanonicalDocumentChangesKey(collectionName) {
  return `${collectionName}CanonicalDocumentChanges`;
}

async function createCollectionsFromCanonical(collections) {
  await db.addCollections(collections);

  const collectionEntries = Object.entries(db.collections);
  for (const [collectionName, collection] of collectionEntries) {
    const replicationState = await createReplicationState(collection);
    const replicationStateKey = getReplicationStateKey(collectionName);
    state.replications[replicationStateKey] = replicationState;
  }

    const codeExtension = await db.collections["code_extension"]
        .findOne().exec();
    const personaName = "ChatBOT"
            case id
    persona = db.collections["persona"].insert({
        id: "[" + codeExtension.id + "][" + personaName + "]",
        name: personaName,
        personaType: "bot",
        modelOptions: ["gpt-3.5-turbo", "gpt-4"],
        modifiedAt: Date().getTime(),
    });
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

      batchSize: 5,
      modifier: (doc) => doc,
    },

    pull: {
      async handler(lastCheckpoint, batchSize) {
        //console.log("Called pull handler with: ", lastCheckpoint, batchSize);

        const canonicalDocumentChangesKey =
          getCanonicalDocumentChangesKey(collectionName);
        const documents =
          state.canonicalDocumentChanges[canonicalDocumentChangesKey] || []; // TODO: Clear on processing? Batch size?

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

function syncDocsFromCanonical(collectionName, changedDocs) {
  const replicationStateKey = getReplicationStateKey(collectionName);
  const replicationState = state.replications[replicationStateKey];

  const canonicalDocumentChangesKey =
    getCanonicalDocumentChangesKey(collectionName);

  state.canonicalDocumentChanges[canonicalDocumentChangesKey] = changedDocs;

  replicationState.reSync();
}

// Public API.
window.createCollectionsFromCanonical = createCollectionsFromCanonical;
window.syncDocsFromCanonical = syncDocsFromCanonical;

// Debug.
window._db = db;
window._state = state;

