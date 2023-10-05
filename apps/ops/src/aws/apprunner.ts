import {
  AppRunnerClient,
  DescribeServiceCommand,
  CreateServiceCommand,
  Service,
  CreateAutoScalingConfigurationCommand,
  ListAutoScalingConfigurationsCommand,
  ListAutoScalingConfigurationsCommandInput,
  DeleteAutoScalingConfigurationCommand,
  DescribeAutoScalingConfigurationCommand,
  UpdateServiceCommand,
  TagResourceCommand,
  DeleteServiceCommand,
  DescribeServiceCommandOutput,
  ListServicesCommandInput,
  ListServicesCommand,
  ServiceSummary,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-apprunner";
import { getTags, TagKeys } from "./defaults";
import { getConfig, SetConfigValueCallback } from "./ssm";
import chalk from "chalk";
import { getEcrRepositoryArn } from "./ecr";
import { Logger } from "../commands/defaults";

const MaxWaitTimeForAppRunnerCreate = 60 * 15;
const MaxWaitTimeForAppRunnerUpdate = 60 * 15;
const apiVersion = "2020-05-15";

function getAppRunnerClient(region: string) {
  return new AppRunnerClient({
    apiVersion,
    region,
  });
}

export async function describeService(
  region: string,
  serviceArn?: string
): Promise<Service | undefined> {
  if (!serviceArn) {
    return undefined;
  }
  const apprunner = getAppRunnerClient(region);
  const command = new DescribeServiceCommand({
    ServiceArn: serviceArn,
  });
  try {
    const result = await apprunner.send(command);
    return result.Service;
  } catch (e: any) {
    if (e.name !== "ResourceNotFoundException") {
      throw e;
    }
    return undefined;
  }
}

export interface AutoScalingSettings {
  minSize: number;
  maxSize: number;
  maxConcurrency: number;
}

export interface HealthCheckSettings {
  path: string;
  interval: number;
  timeout: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
}

export interface EnsureAppRunnerOptions {
  region: string;
  deployment: string;
  component: string;
  ecrRepositoryName: string;
  setAppRunnerUrl: SetConfigValueCallback;
  imageTag: string;
  autoScalingConfigurationName: string;
  autoScaling: AutoScalingSettings;
  healthCheck: HealthCheckSettings;
  appRunnerServiceName: string;
  appRunnerInstanceRoleArn: string;
  appRunnerCpu?: string;
  appRunnerMemory?: string;
  ignoreConfigKeys: string[];
  logger: Logger;
}

export async function deleteUnusedAutoScalingConfigurations(
  region: string,
  autoScalingConfigurationName: string,
  logger: Logger
): Promise<void> {
  const apprunner = getAppRunnerClient(region);
  let listCommandInput: ListAutoScalingConfigurationsCommandInput = {
    AutoScalingConfigurationName: autoScalingConfigurationName,
  };
  while (true) {
    const listResult = await apprunner.send(
      new ListAutoScalingConfigurationsCommand(listCommandInput)
    );
    for (const revision of listResult.AutoScalingConfigurationSummaryList ||
      []) {
      if (!revision.HasAssociatedService && revision.Status === "active") {
        logger(
          `deleting unused AutoScalingConfiguration ${revision.AutoScalingConfigurationArn}...`
        );
        const deleteAutoScalingCommand =
          new DeleteAutoScalingConfigurationCommand({
            AutoScalingConfigurationArn: revision.AutoScalingConfigurationArn,
          });
        await apprunner.send(deleteAutoScalingCommand);
      }
    }
    if (!listResult.NextToken) {
      break;
    }
    listCommandInput.NextToken = listResult.NextToken;
  }
}

async function waitForAppRunnerService(
  region: string,
  serviceArn: string,
  maxWait: number,
  isDeleting: boolean,
  logger: Logger
): Promise<Service | undefined> {
  const apprunner = getAppRunnerClient(region);
  const command = new DescribeServiceCommand({
    ServiceArn: serviceArn,
  });
  let clock = 0;
  let delay = 1;
  while (true) {
    let result: DescribeServiceCommandOutput;
    try {
      result = await apprunner.send(command);
    } catch (e: any) {
      if (e.name === "ResourceNotFoundException" && isDeleting) {
        return undefined;
      }
      throw e;
    }
    logger(`${clock}s service status: ${result.Service?.Status}`);
    if (isDeleting) {
      if (result.Service?.Status === "DELETED") {
        return undefined;
      } else if (result.Service?.Status !== "OPERATION_IN_PROGRESS") {
        logger(
          chalk.red(
            `failure deleting ${serviceArn} service: unexpected service status ${result.Service?.Status}`
          )
        );
        process.exit(1);
      }
    } else {
      if (result.Service?.Status === "RUNNING") {
        return result.Service;
      } else if (result.Service?.Status !== "OPERATION_IN_PROGRESS") {
        logger(
          chalk.red(
            `failure creating ${serviceArn} service: unexpected service status ${result.Service?.Status}`
          )
        );
        process.exit(1);
      }
    }
    if (clock >= maxWait) {
      return isDeleting ? result.Service : undefined;
    }
    if (clock > 60) {
      delay = 10;
    } else if (clock > 20) {
      delay = 5;
    } else if (clock > 5) {
      delay = 2;
    }
    clock += delay;
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
  }
}

function getAutoScalingSettings(options: EnsureAppRunnerOptions) {
  return {
    MaxConcurrency: options.autoScaling.maxConcurrency,
    MaxSize: options.autoScaling.maxSize,
    MinSize: options.autoScaling.minSize,
  };
}

function getHealthCheckSettings(options: EnsureAppRunnerOptions) {
  return {
    Protocol: "HTTP",
    Path: options.healthCheck.path,
    Interval: options.healthCheck.interval,
    Timeout: options.healthCheck.timeout,
    HealthyThreshold: options.healthCheck.healthyThreshold,
    UnhealthyThreshold: options.healthCheck.unhealthyThreshold,
  };
}

async function updateAppRunnerService(
  options: EnsureAppRunnerOptions,
  existingService: Service
): Promise<void> {
  const apprunner = getAppRunnerClient(options.region);
  const ecrRepositoryUrl = await getEcrRepositoryArn(
    options.region,
    options.ecrRepositoryName
  );
  const Tags = getTags(options.region, options.deployment, {
    [TagKeys.LetsGoComponent]: options.component,
  });

  // Clean up unsusued AutoScalingConfigurations to stay within the quota
  await deleteUnusedAutoScalingConfigurations(
    options.region,
    options.autoScalingConfigurationName,
    options.logger
  );

  // Create new AutoScalingConfiguration if needed
  const describeAutoScalingCommand =
    new DescribeAutoScalingConfigurationCommand({
      AutoScalingConfigurationArn:
        existingService.AutoScalingConfigurationSummary
          ?.AutoScalingConfigurationArn || "",
    });
  const autoScalingResponse = await apprunner.send(describeAutoScalingCommand);
  const currentAutoScalingSettings: any =
    autoScalingResponse.AutoScalingConfiguration || {};
  const desiredAutoScalingSettings: any = getAutoScalingSettings(options);
  const autoScalingNeedsUpdate =
    ["MaxConcurrency", "MinSize", "MaxSize"].find(
      (setting) =>
        currentAutoScalingSettings[setting] !==
        desiredAutoScalingSettings[setting]
    ) !== undefined;
  let newAutoScalingConfigurationArn: string | undefined;
  if (autoScalingNeedsUpdate) {
    const createAutoScalingCommand = new CreateAutoScalingConfigurationCommand({
      AutoScalingConfigurationName: options.autoScalingConfigurationName,
      ...desiredAutoScalingSettings,
      Tags,
    });
    const autoScalingResult = await apprunner.send(createAutoScalingCommand);
    newAutoScalingConfigurationArn =
      autoScalingResult.AutoScalingConfiguration?.AutoScalingConfigurationArn;
  }

  // Check if health settings configuration needs to be updated
  const currentHealthCheckSettings: any =
    existingService.HealthCheckConfiguration || {};
  const desiredHealthCheckSettings: any = getHealthCheckSettings(options);
  const healthCheckNeedsUpdate =
    [
      "Path",
      "Interval",
      "Timeout",
      "HealthyThreshold",
      "UnhealthyThreshold",
    ].find(
      (setting) =>
        currentHealthCheckSettings[setting] !==
        desiredHealthCheckSettings[setting]
    ) !== undefined;

  // Check if instance configuration needs to be updated
  const instanceConfigurationNeedsUpdate =
    existingService.InstanceConfiguration?.Cpu !== options.appRunnerCpu ||
    existingService.InstanceConfiguration?.Memory !== options.appRunnerMemory;

  // Check if image needs to be updated
  const imageNeedsUpdate =
    (existingService.SourceConfiguration?.ImageRepository?.ImageIdentifier ||
      "") !== `${ecrRepositoryUrl}:${options.imageTag}`;

  // Check if config need to be updated
  const currentConfigKeys = Object.keys(
    existingService.SourceConfiguration?.ImageRepository?.ImageConfiguration
      ?.RuntimeEnvironmentSecrets || {}
  );
  const desiredConfig =
    (await getConfig(options.region, options.deployment, true))[
      options.region
    ]?.[options.deployment] || {};
  const desiredConfigKeys = Object.keys(desiredConfig);
  const configNeedsUpdate =
    desiredConfigKeys.find(
      (key) =>
        !currentConfigKeys.includes(key) &&
        !options.ignoreConfigKeys.includes(key)
    ) !== undefined ||
    currentConfigKeys.find(
      (key) =>
        !desiredConfigKeys.includes(key) &&
        !options.ignoreConfigKeys.includes(key)
    ) !== undefined;

  // Update plan
  const updatePlan: string[] = [
    ...(newAutoScalingConfigurationArn ? ["autoscaling settings"] : []),
    ...(healthCheckNeedsUpdate ? ["healthcheck settings"] : []),
    ...(instanceConfigurationNeedsUpdate ? ["instance configuration"] : []),
    ...(imageNeedsUpdate ? ["image"] : []),
    ...(configNeedsUpdate ? ["variables"] : []),
  ];
  if (updatePlan.length > 0) {
    // Updating service
    options.logger(
      `updating ${options.component}: ${updatePlan.join(", ")}...`
    );
    const updatedAt = new Date().toISOString();
    const updateServiceCommand = new UpdateServiceCommand({
      ServiceArn: existingService.ServiceArn,
      ...(newAutoScalingConfigurationArn
        ? { AutoScalingConfigurationArn: newAutoScalingConfigurationArn }
        : {}),
      ...(healthCheckNeedsUpdate
        ? {
            HealthCheckConfiguration: {
              ...desiredHealthCheckSettings,
            },
          }
        : {}),
      ...(instanceConfigurationNeedsUpdate
        ? {
            InstanceConfiguration: {
              InstanceRoleArn: options.appRunnerInstanceRoleArn,
              Cpu: options.appRunnerCpu,
              Memory: options.appRunnerMemory,
            },
          }
        : {}),
      ...(imageNeedsUpdate || configNeedsUpdate
        ? {
            SourceConfiguration: {
              ImageRepository: {
                ImageIdentifier: `${ecrRepositoryUrl}:${options.imageTag}`,
                ImageRepositoryType: "ECR",
                ...(configNeedsUpdate
                  ? {
                      ImageConfiguration: {
                        RuntimeEnvironmentSecrets: desiredConfig,
                        RuntimeEnvironmentVariables: {
                          LETSGO_IMAGE_TAG: options.imageTag,
                          LETSGO_DEPLOYMENT: options.deployment,
                          LETSGO_UPDATED_AT: updatedAt,
                          // Workaround for a Next.js issue. See https://github.com/vercel/next.js/issues/49777
                          HOSTNAME: "0.0.0.0",
                        },
                      },
                    }
                  : {}),
              },
              AutoDeploymentsEnabled: false,
              AuthenticationConfiguration: {
                AccessRoleArn: options.appRunnerInstanceRoleArn,
              },
            },
          }
        : {}),
    });
    await apprunner.send(updateServiceCommand);
    const tagResourceCommand = new TagResourceCommand({
      ResourceArn: existingService.ServiceArn,
      Tags: getTags(options.region, options.deployment, {
        [TagKeys.LetsGoComponent]: options.component,
      }),
    });
    await apprunner.send(tagResourceCommand);
    const service = await waitForAppRunnerService(
      options.region,
      existingService.ServiceArn || "",
      MaxWaitTimeForAppRunnerUpdate,
      false,
      options.logger
    );
    if (!service) {
      options.logger(
        chalk.red(
          `${options.component} was updated but did not reach the RUNNING state within ${MaxWaitTimeForAppRunnerUpdate} seconds`
        )
      );
      options.logger(
        chalk.red(
          `you can continue checking the status of the ${options.component} service at https://${existingService.ServiceUrl}`
        )
      );
      process.exit(1);
    }
    if (
      service.SourceConfiguration?.ImageRepository?.ImageConfiguration
        ?.RuntimeEnvironmentVariables?.LETSGO_UPDATED_AT !== updatedAt
    ) {
      options.logger(
        chalk.red(
          `${options.component} update failed and the deployment was rolled back to the previous version`
        )
      );
      options.logger(
        chalk.red(
          `check the AWS App Runner application logs in AWS for more information`
        )
      );
      process.exit(1);
    }
  }
  options.logger(
    `${options.component} is up to date at ${chalk.green(
      `https://${existingService.ServiceUrl}`
    )}`
  );
}

async function createAppRunnerService(
  options: EnsureAppRunnerOptions
): Promise<void> {
  const apprunner = getAppRunnerClient(options.region);
  const ecrRepositoryUrl = await getEcrRepositoryArn(
    options.region,
    options.ecrRepositoryName
  );
  const Tags = getTags(options.region, options.deployment, {
    [TagKeys.LetsGoComponent]: options.component,
  });

  // Clean up unsusued AutoScalingConfigurations to stay within the quota
  await deleteUnusedAutoScalingConfigurations(
    options.region,
    options.autoScalingConfigurationName,
    options.logger
  );

  // Create AutoScalingConfiguration
  options.logger(
    `creating AutoScalingConfiguration ${options.autoScalingConfigurationName}...`
  );
  const createAutoScalingCommand = new CreateAutoScalingConfigurationCommand({
    AutoScalingConfigurationName: options.autoScalingConfigurationName,
    ...getAutoScalingSettings(options),
    Tags,
  });
  const autoScalingResult = await apprunner.send(createAutoScalingCommand);

  // Create AppRunner Service
  options.logger(`creating ${options.component} service...`);
  const createServiceCommand = new CreateServiceCommand({
    ServiceName: options.appRunnerServiceName,
    SourceConfiguration: {
      ImageRepository: {
        ImageIdentifier: `${ecrRepositoryUrl}:${options.imageTag}`,
        ImageRepositoryType: "ECR",
        ImageConfiguration: {
          RuntimeEnvironmentSecrets:
            (await getConfig(options.region, options.deployment, true))[
              options.region
            ]?.[options.deployment] || {},
          RuntimeEnvironmentVariables: {
            LETSGO_IMAGE_TAG: options.imageTag,
            LETSGO_DEPLOYMENT: options.deployment,
            LETSGO_UPDATED_AT: new Date().toISOString(),
            // Workaround for a Next.js issue. See https://github.com/vercel/next.js/issues/49777
            HOSTNAME: "0.0.0.0",
          },
        },
      },
      AutoDeploymentsEnabled: false,
      AuthenticationConfiguration: {
        AccessRoleArn: options.appRunnerInstanceRoleArn,
      },
    },
    InstanceConfiguration: {
      InstanceRoleArn: options.appRunnerInstanceRoleArn,
      Cpu: options.appRunnerCpu,
      Memory: options.appRunnerMemory,
    },
    Tags,
    HealthCheckConfiguration: {
      ...getHealthCheckSettings(options),
    },
    ...{
      AutoScalingConfigurationArn:
        autoScalingResult.AutoScalingConfiguration?.AutoScalingConfigurationArn,
    },
    NetworkConfiguration: {
      IngressConfiguration: {
        IsPubliclyAccessible: true,
      },
    },
  });
  const createServiceResult = await apprunner.send(createServiceCommand);
  await options.setAppRunnerUrl(
    createServiceResult.Service?.ServiceUrl
      ? `https://${createServiceResult.Service?.ServiceUrl}`
      : ""
  );
  const service = await waitForAppRunnerService(
    options.region,
    createServiceResult.Service?.ServiceArn || "",
    MaxWaitTimeForAppRunnerCreate,
    false,
    options.logger
  );
  if (service) {
    options.logger(
      `${options.component} created at ${chalk.green(
        `https://${service?.ServiceUrl}`
      )}`
    );
  } else {
    options.logger(
      chalk.red(
        `${options.component} was created but did not reach the RUNNING state within ${MaxWaitTimeForAppRunnerCreate} seconds. `
      )
    );
    options.logger(
      chalk.red(
        `you can continue checking the status of the ${options.component} service at https://${createServiceResult.Service?.ServiceUrl}`
      )
    );
    process.exit(1);
  }
}

export async function deleteAppRunnerService(
  region: string,
  serviceArn: string,
  logger: Logger
): Promise<void> {
  const apprunner = getAppRunnerClient(region);
  const deleteServiceCommand = new DeleteServiceCommand({
    ServiceArn: serviceArn,
  });
  logger(`deleting service ${serviceArn}...`);
  try {
    await apprunner.send(deleteServiceCommand);
  } catch (e: any) {
    if (e.name === "InvalidStateException") {
      logger(chalk.red(e.message));
      process.exit(1);
    }
    if (e.name !== "ResourceNotFoundException") {
      throw e;
    }
    return;
  }
  const service = await waitForAppRunnerService(
    region,
    serviceArn,
    MaxWaitTimeForAppRunnerUpdate,
    true,
    logger
  );
  if (service) {
    logger(
      chalk.red(
        `service ${serviceArn} was deleted but did not reach the DELETED state within ${MaxWaitTimeForAppRunnerUpdate} seconds. `
      )
    );
    process.exit(1);
  }
}

export async function listLetsGoAppRunnerServices(
  region: string,
  deployment?: string,
  component?: string
): Promise<ServiceSummary[]> {
  const apprunner = getAppRunnerClient(region);
  const listInput: ListServicesCommandInput = {};
  const services: ServiceSummary[] = [];
  while (true) {
    const result = await apprunner.send(new ListServicesCommand(listInput));
    for (const service of result.ServiceSummaryList || []) {
      const listTagsCommand = new ListTagsForResourceCommand({
        ResourceArn: service.ServiceArn || "",
      });
      const tagsResult = await apprunner.send(listTagsCommand);
      const deploymentValue = tagsResult.Tags?.find(
        (tag) => tag.Key === TagKeys.LetsGoDeployment
      )?.Value;
      const componentValue = tagsResult.Tags?.find(
        (tag) => tag.Key === TagKeys.LetsGoComponent
      )?.Value;
      if (
        deploymentValue &&
        componentValue &&
        (!deployment || deployment === deploymentValue) &&
        (!component || component === componentValue)
      ) {
        services.push(service);
      }
    }
    if (!result.NextToken) {
      break;
    }
    listInput.NextToken = result.NextToken;
  }
  return services;
}

async function getOneLetsGoAppRunnerService(
  options: EnsureAppRunnerOptions
): Promise<ServiceSummary | undefined> {
  options.logger(`discovering ${options.component} services...`);
  let existingServices = await listLetsGoAppRunnerServices(
    options.region,
    options.deployment,
    options.component
  );
  if (existingServices.length > 1) {
    options.logger(
      chalk.red(
        `found multiple ${options.component} services, and expected only one:`
      )
    );
    existingServices.forEach((service) =>
      options.logger(
        chalk.red(`  ${service.ServiceArn} (${service.ServiceUrl})`)
      )
    );
    options.logger(
      chalk.red(
        `manually resolve this issue by deleting the ${options.component} services you don't need in AWS, then try again`
      )
    );
    process.exit(1);
  }
  if (existingServices.length === 0) {
    options.logger(`existing ${options.component} service not found`);
    return undefined;
  }
  options.logger(
    `found ${options.component} service https://${existingServices[0]?.ServiceUrl}`
  );
  return existingServices[0];
}

export async function ensureAppRunner(
  options: EnsureAppRunnerOptions
): Promise<void> {
  let existingServiceSummary = await getOneLetsGoAppRunnerService(options);
  if (existingServiceSummary?.Status === "OPERATION_IN_PROGRESS") {
    options.logger(
      chalk.red(
        `the ${options.component} service is currently being updated, please try again later`
      )
    );
    process.exit(1);
  }

  if (existingServiceSummary?.Status === "CREATE_FAILED") {
    await deleteAppRunnerService(
      options.region,
      existingServiceSummary.ServiceArn || "",
      options.logger
    );
    existingServiceSummary = undefined;
  }

  const existingService =
    existingServiceSummary &&
    (await describeService(options.region, existingServiceSummary.ServiceArn));

  if (!existingService || existingServiceSummary?.Status === "DELETED") {
    await createAppRunnerService(options);
  } else {
    await updateAppRunnerService(options, existingService);
  }
}
