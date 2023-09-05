import { addRxPlugin, createRxDatabase, lastOfArray } from "skypack:rxdb";

import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";

const EPOCH = new Date();

addRxPlugin(RxDBDevModePlugin);

function handleSubscriptionEvent(changeEvent) {
  if (changeEvent) {
  }
}

const ChatOnMacPlugin = {
  name: "chatonmac",
  rxdb: true,
  hooks: {
    createRxCollection: {
      after: async (args) => {
        args.collection.$.subscribe(async (changeEvent) => {
          if (
            changeEvent.documentData.createdAt > EPOCH.getTime() &&
            changeEvent.collectionName === "event" &&
            !changeEvent.documentData.content.startsWith("bot:")
          ) {
            const content = changeEvent.documentData.content;
            window.changeEvent = changeEvent;
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
                    {
                      role: "user",
                      content,
                    },
                  ],
                }),
              }
            );
            const llmResp = await resp.json();
            window.llmResp = llmResp;

            const events = window._db.collections["event"];
            events.insert({
              id: crypto.randomUUID(),
              content: `bot:${llmResp.choices[0].message.content}`,
              type: "message",
              room: changeEvent.documentData.room,
              sender: null, // Persona.
              createdAt: new Date().getTime(),
              modifiedAt: new Date().getTime(),
            });
          }
        });
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
        console.log("Called push handler with: ", docs);

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
        console.log("Called pull handler with: ", lastCheckpoint, batchSize);

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
