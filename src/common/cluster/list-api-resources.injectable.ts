/**
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type {
  V1APIGroupList,
  V1APIResourceList,
  V1APIVersions,
} from "@kubernetes/client-node";
import { getInjectable } from "@ogre-tools/injectable";
import type { K8sRequest } from "../../main/k8s-request.injectable";
import k8SRequestInjectable from "../../main/k8s-request.injectable";
import type { Logger } from "../logger";
import loggerInjectable from "../logger.injectable";
import type { KubeApiResource, KubeResource } from "../rbac";
import type { Cluster } from "./cluster";
import plimit from "p-limit";

export type RequestListApiResources = () => Promise<KubeApiResource[]>;

/**
 * @param proxyConfig This config's `currentContext` field must be set, and will be used as the target cluster
 */
export type ListApiResources = (cluster: Cluster) => RequestListApiResources;

interface Dependencies {
  logger: Logger;
  k8sRequest: K8sRequest;
}

const listApiResources = ({ k8sRequest, logger }: Dependencies): ListApiResources => {
  return (cluster) => {
    return async () => {
      const resources: KubeApiResource[] = [];

      try {
        const apiLimit = plimit(5);
        const clusterRequest = <T>(path: string) => apiLimit(
          () => k8sRequest(cluster, path).catch(error => {
            logger.error(`[LIST-API-RESOURCES]: request ${path} failed: ${error}`);
          }) as Promise<T | undefined>);

        const resourceListGroups: { group: string; path: string }[] = [];

        await Promise.all(
          [
            clusterRequest<V1APIVersions>("/api").then((response) => response?.versions.forEach(version => resourceListGroups.push({ group: version, path: `/api/${version}` }))),
            clusterRequest<V1APIGroupList>("/apis").then((response) => response?.groups.forEach(group => {
              const preferredVersion = group.preferredVersion?.groupVersion;

              if (preferredVersion) {
                resourceListGroups.push({ group: group.name, path: `/apis/${preferredVersion}` });
              }
            })),
          ],
        );

        await Promise.all(
          resourceListGroups.map(({ group, path }) => clusterRequest<V1APIResourceList>(path).then(apiResources => {
            if (apiResources?.resources) {
              resources.push(
                ...apiResources.resources.filter(resource => resource.verbs.includes("list")).map((resource) => ({
                  apiName: resource.name as KubeResource,
                  kind: resource.kind,
                  group,
                })),
              );
            }
          },
          )),
        );
      } catch (error) {
        logger.error(`[LIST-API-RESOURCES]: failed to list api resources: ${error}`);
      }

      return resources;
    };
  };
};

const listApiResourcesInjectable = getInjectable({
  id: "list-api-resources",
  instantiate: (di) => {
    const k8sRequest = di.inject(k8SRequestInjectable);
    const logger = di.inject(loggerInjectable);

    return listApiResources({ k8sRequest, logger });
  },
});

export default listApiResourcesInjectable;
