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

async function createCollectionsFromCanonical(collections) {
  await db.addCollections(collections);

  for (const collection of db.collections) {
    const replicationState = await createReplicationState(collection);
    const replicationStateKey = getReplicationStateKey(collection.name);
    state.replications[replicationStateKey].property = replicationState;
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
  const replicationState = state.replications[replicationStateKey];

  const canonicalDocumentChangesKey =
    getCanonicalDocumentChangesKey(collectionName);

  state.canonicalDocumentChanges[canonicalDocumentChangesKey].property =
    changedDocs;

  replicationState.reSync();
}

window.createCollectionsFromCanonical = createCollectionsFromCanonical;
window.syncDocsFromCanonical = syncDocsFromCanonical;
