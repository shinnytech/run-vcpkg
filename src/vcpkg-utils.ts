// Copyright (c) 2020-2021-2022-2023 Luca Cappa
// Released under the term specified in file LICENSE.txt
// SPDX short identifier: MIT

import * as path from 'path'
import * as fs from 'fs'
import * as runvcpkglib from '@lukka/run-vcpkg-lib'
import * as baselib from '@lukka/base-lib'
import * as baseutillib from '@lukka/base-util-lib'
import * as cache from '@actions/cache'
import * as fastglob from "fast-glob"

export class Utils {

  public static isExactKeyMatch(key: string, cacheKey?: string): boolean {
    if (cacheKey)
      return cacheKey.localeCompare(key, undefined, { sensitivity: "accent" }) === 0;
    else
      return false;
  }

  /**
   * Retrieve the commit id of the Git repository at vcpkgDirectory.
   * Returns [undefined, undefined] when the provided path is not the root of a Git repository.
   * @static
   * @param {baseutillib.BaseUtilLib} baseUtils
   * @param {string} vcpkgDirectory
   * @returns {(Promise<[string | undefined, boolean | undefined]>)}
   * @memberof Utils
   */
  public static async getVcpkgCommitId(baseUtils: baseutillib.BaseUtilLib, vcpkgDirectory: string): Promise<[string | undefined, boolean | undefined]> {
    baseUtils.baseLib.debug(`getVcpkgCommitId()<<`);
    let id = undefined;
    let isSubmodule = undefined;
    const workspaceDir = process.env.GITHUB_WORKSPACE ?? "";
    if (workspaceDir) {
      let fullVcpkgPath = "";
      baseUtils.baseLib.debug(`inputVcpkgPath=${vcpkgDirectory}`);
      if (path.isAbsolute(vcpkgDirectory))
        fullVcpkgPath = path.normalize(path.resolve(vcpkgDirectory));
      else
        fullVcpkgPath = path.normalize(path.resolve(path.join(workspaceDir, vcpkgDirectory)));
      baseUtils.baseLib.debug(`fullVcpkgPath='${fullVcpkgPath}'`);
      const relPath = fullVcpkgPath.replace(workspaceDir, '');
      baseUtils.baseLib.debug(`relPath='${relPath}'`);
      const submodulePath = path.join(workspaceDir, ".git/modules", relPath, "HEAD")
      baseUtils.baseLib.debug(`submodulePath='${submodulePath}'`);
      // Check whether it is a submodule.
      if (fs.existsSync(submodulePath)) {
        id = fs.readFileSync(submodulePath).toString();
        baseUtils.baseLib.debug(`commitId='${id}'`);
        isSubmodule = true;
      } else if (fs.existsSync(path.join(fullVcpkgPath, ".git"))) {
        id = await runvcpkglib.VcpkgRunner.getCommitId(baseUtils, fullVcpkgPath);
        isSubmodule = false;
      }
      id = id?.trim();
    }
    baseUtils.baseLib.debug(`getVcpkgCommitId()>> -> [id=${id}, isSubmodule=${isSubmodule}]`);
    return [id, isSubmodule];
  }

  public static async getVcpkgJsonPath(baseUtil: baseutillib.BaseUtilLib, vcpkgJsonGlob: string,
    vcpkgJsonIgnores: string[]): Promise<string | null> {
    baseUtil.baseLib.debug(`getVcpkgJsonPath(${vcpkgJsonGlob})<<`);
    let ret: string | null = null;
    try {
      const vcpkgJsonPath = await fastglob(vcpkgJsonGlob, { ignore: vcpkgJsonIgnores });
      if (vcpkgJsonPath?.length === 1) {
        baseUtil.baseLib.info(`Found ${runvcpkglib.VCPKG_JSON} at '${vcpkgJsonPath[0]}'.`);
        ret = vcpkgJsonPath[0];
      } else if (vcpkgJsonPath.length > 1) {
        baseUtil.baseLib.warning(`The file ${runvcpkglib.VCPKG_JSON} was found multiple times with glob expression '${vcpkgJsonGlob}'.`);
      } else {
        baseUtil.baseLib.warning(`The file ${runvcpkglib.VCPKG_JSON} was not found with glob expression '${vcpkgJsonGlob}'.`);
      }
    }
    catch (err) {
      if (err instanceof Error) {
        baseUtil.baseLib.warning(err.message);
      }
    }

    baseUtil.baseLib.debug(`getVcpkgJsonPath()>>`);
    return ret;
  }

  public static async computeCacheKeys(
    baseUtilLib: baseutillib.BaseUtilLib,
    vcpkgDirectory: string,
    userProvidedCommitId: string | null): Promise<baseutillib.KeySet> {
    baseUtilLib.baseLib.debug(`computeCacheKeys()<<`);
    const cacheKeySegments: string[] = [];

    // Add to the first segment of the key the values of env vars ImageOS and ImageVersion if available.
    let firstSegment = `runnerOS=${process.env['ImageOS'] ? process.env['ImageOS'] : process.platform}`;
    firstSegment += process.env['ImageVersion'] || "";

    const [commitId, isSubmodule] = await Utils.getVcpkgCommitId(baseUtilLib, vcpkgDirectory);
    if (commitId) {
      firstSegment += `-vcpkgGitCommit=${commitId}`;
      if (isSubmodule) {
        baseUtilLib.baseLib.info(`Adding vcpkg submodule Git commit id '${commitId}' to cache key`);
        if (userProvidedCommitId) {
          baseUtilLib.baseLib.warning(`The provided Git commit id is disregarded: '${userProvidedCommitId}'. Please remove it from the inputs.`);
        }
      } else {
        baseUtilLib.baseLib.info(`vcpkg identified at Git commit id '${commitId}', adding it to the cache's key.`);
      }
    } else if (userProvidedCommitId) {
      firstSegment += `-vcpkgGitCommit=${userProvidedCommitId}`;
      baseUtilLib.baseLib.info(`Adding user provided vcpkg's Git commit id '${userProvidedCommitId}' to cache key.`);
    } else {
      baseUtilLib.baseLib.info(`No vcpkg's commit id was provided, does not contribute to the cache's key.`);
    }

    cacheKeySegments.push(firstSegment);

    const keyset: baseutillib.KeySet = baseutillib.createKeySet(cacheKeySegments);
    baseUtilLib.baseLib.debug(`computeCacheKeys()>>`);
    return keyset;
  }

  public static async saveCache(baseUtilLib: baseutillib.BaseUtilLib, keys: baseutillib.KeySet,
    hitCacheKey: string | null, cachedPaths: string[]): Promise<void> {
    const baseLib = baseUtilLib.baseLib;
    baseLib.debug(`saveCache(keys:${JSON.stringify(keys)},hitCacheKey:${hitCacheKey},cachedPaths:${cachedPaths})<<`)
    try {
      await baseUtilLib.wrapOp('Save vcpkg into the GitHub Action cache (only the tool, not the built packages which are saved by vcpkg`s Binary Caching on GitHub Action`s cache).',
        async () => {

          if (hitCacheKey && Utils.isExactKeyMatch(keys.primary, hitCacheKey)) {
            baseLib.info(`Saving cache is skipped, because cache hit occurred on the cache key '${keys.primary}'.`);
          } else {
            baseLib.info(`Saving a new cache entry, because primary key was missed or a fallback restore key was hit.`);
            const pathsToCache: string[] = cachedPaths;
            baseLib.info(`Caching paths: '${pathsToCache}'`);

            try {
              baseLib.info(`Saving cache with primary key '${keys.primary}' ...`);
              await cache.saveCache(pathsToCache, keys.primary);
            }
            catch (error) {
              if (error instanceof Error) {
                if (error.name === cache.ValidationError.name) {
                  throw error;
                } else if (error.name === cache.ReserveCacheError.name) {
                  baseLib.info(error.message);
                } else {
                  baseLib.warning(error.message);
                }
              }
            }
          }
        });
    } catch (err) {
      baseLib.warning("vcpkg-utils.saveCache() failed!");
      if (err instanceof Error) {
        baseLib.warning(err.name);
        baseLib.warning(err.message);
        if (err?.stack) {
          baseLib.warning(err.stack);
        }
      }
    }

    baseLib.debug(`saveCache()>>`)
  }

  public static getAllCachedPaths(baseLib: baselib.BaseLib, vcpkgRootDir: string): string[] {
    baseLib.debug(`getAllCachedPaths(${vcpkgRootDir})<<`);
    let pathsToCache: string[] = runvcpkglib.getOrdinaryCachedPaths(vcpkgRootDir);

    // Remove empty entries.
    pathsToCache = pathsToCache.map(s => s.trim()).filter(Boolean);

    // Remove duplicates.
    const ps = [...new Set(pathsToCache)];

    baseLib.debug(`getAllCachedPaths(${vcpkgRootDir})<< -> '${JSON.stringify(ps)}'`);
    return ps;
  }
}
