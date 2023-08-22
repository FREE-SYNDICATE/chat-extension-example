import { addRxPlugin, createRxDatabase, lastOfArray } from "skypack:rxdb";

import { RxDBDevModePlugin } from "skypack:rxdb/plugins/dev-mode";
import { replicateRxCollection } from "skypack:rxdb/plugins/replication";
import { getRxStorageMemory } from "skypack:rxdb/plugins/storage-memory";

addRxPlugin(RxDBDevModePlugin);

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

async function test() {
  return "test";
}

async function createCollectionsFromCanonical(collections) {
  console.log(collections);
  await db.addCollections(collections);

  const collectionEntries = Object.entries(db.collections);
  for (const [collectionName, collection] of collectionEntries) {
    console.log("foo");
    const replicationState = await createReplicationState(collection);
    const replicationStateKey = getReplicationStateKey(collectionName);
    console.log(replicationStateKey);
    state.replications[replicationStateKey] = replicationState;
  }

  return "test";
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

    deletedField: "deleted", // TODO.

    push: {
      async handler(docs) {
        console.log("Called handler with: ", docs);

        // TODO:
        // window.postMessage(JSON.stringify(docs), "*");

        return {};
      },

      batchSize: 5,
      modifier: (d) => d,
    },

    pull: {
      async handler(lastCheckpoint, batchSize) {
        console.log("Called pull handler with: ", lastCheckpoint, batchSize);

        const canonicalDocumentChangesKey =
          getCanonicalDocumentChangesKey(collectionName);
        const documents =
          state.canonicalDocumentChanges[canonicalDocumentChangesKey]; // TODO: Clear on processing? Batch size?
        const checkpoint =
          documents.length === 0
            ? lastCheckpoint
            : {
                id: lastOfArray(documents).id,
                updatedAt: lastOfArray(documents).updatedAt,
              };

        window[`${collectionName}LastCheckpoint`] = checkpoint;

        return {
          documents,
          checkpoint,
        };
      },

      batchSize: 10,
      modifier: (d) => d,
    },
  });

  return replicationState;
}

function syncDocsFromCanonical(collectionName, changedDocs) {
  const replicationStateKey = getReplicationStateKey(collectionName);
  console.log(db, state, replicationStateKey);
  const replicationState = state.replications[replicationStateKey];

  const canonicalDocumentChangesKey =
    getCanonicalDocumentChangesKey(collectionName);

  state.canonicalDocumentChanges[canonicalDocumentChangesKey] = changedDocs;

  replicationState.reSync();
}

window.createCollectionsFromCanonical = createCollectionsFromCanonical;
window.syncDocsFromCanonical = syncDocsFromCanonical;

// Debug.
window.db = db;
window.state = state;

window.test = test;
