/**
 *
 *    Copyright (c) 2020 Silicon Labs
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

/*
 * This file provides the functionality that reads the ZAP data from a database
 * and exports it into a file.
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const env = require('../util/env.js')
const querySession = require('../db/query-session.js')
const queryConfig = require('../db/query-config.js')
const queryImpExp = require('../db/query-impexp.js')
const dbEnum = require('../../src-shared/db-enum.js')

/**
 * Resolves to an array of objects that contain 'key' and 'value'
 *
 * @export
 * @param {*} db
 * @param {*} sessionId
 * @returns Promise to retrieve all session key values.
 */
function exportSessionKeyValues(db, sessionId) {
  return queryConfig.getAllSessionKeyValues(db, sessionId)
}

/**
 * Resolves to an array of endpoints.
 *
 * @param {*} db
 * @param {*} sessionId
 * @returns Promise to retrieve all endpoints.
 */
function exportEndpoints(db, sessionId, endpointTypes) {
  return queryImpExp.exportEndpoints(db, sessionId, endpointTypes)
}

/**
 * Resolves to an array of endpoint types.
 *
 * @export
 * @param {*} db
 * @param {*} sessionId
 * @returns Promise to retrieve all endpoint types.
 */
function exportEndpointTypes(db, sessionId) {
  return queryImpExp
    .exportEndpointTypes(db, sessionId)
    .then((endpointTypes) => {
      var promises = []
      endpointTypes.forEach((endpointType) => {
        // Add in the clusters.
        promises.push(
          queryImpExp
            .exportClustersFromEndpointType(db, endpointType.endpointTypeId)
            .then((data) => {
              endpointType.clusters = data

              var ps = []
              data.forEach((endpointCluster) => {
                var endpointClusterId = endpointCluster.endpointClusterId
                delete endpointCluster.endpointClusterId
                ps.push(
                  queryImpExp
                    .exportCommandsFromEndpointTypeCluster(
                      db,
                      endpointType.endpointTypeId,
                      endpointClusterId
                    )
                    .then((commands) => {
                      endpointCluster.commands = commands
                      return commands
                    })
                )

                ps.push(
                  queryImpExp
                    .exportAttributesFromEndpointTypeCluster(
                      db,
                      endpointType.endpointTypeId,
                      endpointClusterId
                    )
                    .then((attributes) => {
                      endpointCluster.attributes = attributes
                      return attributes
                    })
                )
              })
              return Promise.all(ps)
            })
        )
      })

      return Promise.all(promises)
        .then(() => exportEndpoints(db, sessionId, endpointTypes))
        .then((endpoints) => {
          return Promise.resolve(endpoints)
        })
        .then((endpoints) => {
          endpointTypes.forEach((ep) => {
            delete ep.endpointTypeId
          })
          return { endpointTypes: endpointTypes, endpoints: endpoints }
        })
    })
}

/**
 * Resolves with data for packages.
 *
 * @param {*} db
 * @param {*} sessionId
 */
function exportSessionPackages(db, sessionId, zapFileLocation) {
  return queryImpExp.exportPackagesFromSession(db, sessionId).then((packages) =>
    packages.map((p) => {
      var pathRelativity = dbEnum.pathRelativity.relativeToUserHome
      var relativePath = path.relative(os.homedir(), p.path)
      if (zapFileLocation != null) {
        var rel = path.relative(zapFileLocation, p.path)
        if (rel.length > 0) {
          relativePath = rel
          pathRelativity = dbEnum.pathRelativity.relativeToZap
        }
      }
      return {
        pathRelativity: pathRelativity,
        path: relativePath,
        version: p.version,
        type: p.type,
      }
    })
  )
}

/**
 * Toplevel file that takes a given session ID and exports the data into the file
 *
 * @export
 * @param {*} db
 * @param {*} sessionId
 * @param {*} filePath
 * @returns A promise that resolves with the path of the file written.
 */
function exportDataIntoFile(db, sessionId, filePath) {
  env.logInfo(`Writing state from session ${sessionId} into file ${filePath}`)
  return createStateFromDatabase(db, sessionId)
    .then((state) => {
      env.logInfo(`About to write the file to ${filePath}`)
      env.logInfo(state)
      return new Promise((resolve, reject) => {
        env.logInfo(`Writing the file to ${filePath}`)
        fs.writeFile(filePath, JSON.stringify(state, null, 2), (err) => {
          if (err) reject(err)
          resolve()
        })
      })
    })
    .then(() => {
      return querySession.setSessionClean(db, sessionId)
    })
    .then(() => {
      return Promise.resolve(filePath)
    })
}

/**
 * Given a database and a session id, this method returns a promise that
 * resolves with a state object that needs to be saved into a file.
 *
 * @export
 * @param {*} db
 * @param {*} sessionId
 * @returns state object that needs to be saved into a file.
 */
function createStateFromDatabase(db, sessionId) {
  return new Promise((resolve, reject) => {
    var state = {
      writeTime: new Date().toString(),
      featureLevel: env.zapVersion().featureLevel,
      creator: 'zap',
    }
    var promises = []
    var excludedKeys = [dbEnum.sessionKey.filePath]

    env.logInfo(`Exporting data for session: ${sessionId}`)
    // Deal with the key/value table
    var getKeyValues = exportSessionKeyValues(db, sessionId)
      .then((data) => {
        env.logInfo(`Retrieved session keys: ${data.length}`)
        var zapFilePath = null
        var storedKeyValuePairs = data.filter(
          (x) => !excludedKeys.includes(x.key)
        )
        var x = data.filter((x) => x.key == dbEnum.sessionKey.filePath)
        if (x.length > 0) zapFilePath = x[0].value
        return {
          key: 'keyValuePairs',
          data: storedKeyValuePairs,
          zapFilePath: zapFilePath,
        }
      })
      .then((data) => {
        return exportSessionPackages(db, sessionId, data.zapFilePath).then(
          (d) => {
            return [data, { key: 'package', data: d }]
          }
        )
      })
    promises.push(getKeyValues)

    var getAllEndpointTypes = exportEndpointTypes(db, sessionId)
    var parseEndpointTypes = getAllEndpointTypes.then((data) => {
      env.logInfo(`Retrieved endpoint types: ${data.endpointTypes.length}`)
      return { key: 'endpointTypes', data: data.endpointTypes }
    })
    var parseEndpoints = getAllEndpointTypes.then((data) => {
      env.logInfo(`Retrieve endpoints: ${data.endpoints.length}`)
      return { key: 'endpoints', data: data.endpoints }
    })

    promises.push(parseEndpointTypes)
    promises.push(parseEndpoints)

    return Promise.all(promises)
      .then((data) => {
        data.flat().forEach((keyDataPair) => {
          state[keyDataPair.key] = keyDataPair.data
        })
        resolve(state)
      })
      .catch((err) => reject(err))
  })
}
// exports
exports.exportDataIntoFile = exportDataIntoFile
exports.createStateFromDatabase = createStateFromDatabase
