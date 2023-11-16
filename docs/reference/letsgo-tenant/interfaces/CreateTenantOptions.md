[@letsgo/tenant](../README.md) / CreateTenantOptions

# Interface: CreateTenantOptions

Options for creating a new tenants.

## Hierarchy

- `DeploymentOptions`

  ↳ **`CreateTenantOptions`**

## Table of contents

### Properties

- [createdBy](CreateTenantOptions.md#createdby)
- [deployment](CreateTenantOptions.md#deployment)
- [displayName](CreateTenantOptions.md#displayname)
- [region](CreateTenantOptions.md#region)

## Properties

### createdBy

• **createdBy**: `Identity`

The identity of the user who is creating the tenant.

#### Defined in

[tenant/src/index.ts:447](https://github.com/tjanczuk/letsgo/blob/f8169ee/packages/tenant/src/index.ts#L447)

___

### deployment

• `Optional` **deployment**: `string`

#### Inherited from

DeploymentOptions.deployment

#### Defined in

db/dist/index.d.ts:3

___

### displayName

• `Optional` **displayName**: `string`

The tenant's display name. If not specified, a random display name is generated.

#### Defined in

[tenant/src/index.ts:451](https://github.com/tjanczuk/letsgo/blob/f8169ee/packages/tenant/src/index.ts#L451)

___

### region

• `Optional` **region**: `string`

#### Inherited from

DeploymentOptions.region

#### Defined in

db/dist/index.d.ts:2