targetScope = 'subscription'

@allowed(['westus2'])
param location string
param resourceGroupName string
param functionAppName string
param planName string
param storageAccountName string
param releaseStorageAccountName string
param hostIdentityName string
param keyVaultName string
param logAnalyticsName string
param applicationInsightsName string
param budgetName string

@secure()
@minLength(3)
param budgetAlertEmail string

@secure()
@description('Protected exact owner mailto: identity for capability observations; does not establish source semantics or enable classification.')
param agendaOwnerAddress string

@description('Original budget creation month start in UTC; preserve it on repeat deployments.')
param budgetStartDate string
param sourceSecretName string = 'calendar-source-url'
param cacheContainerName string = 'source-cache'
param deploymentContainerName string = 'app-packages'
param releaseControlContainerName string = 'release-control'
param releaseArtifactContainerName string = 'release-artifacts'
@description('Object ID of the OIDC release controller service principal; empty until owner bootstrap.')
param releaseControllerPrincipalId string = ''

@description('Retain the Functions host startup diagnostics using its documented Table data role.')
param retainHostDiagnostics bool = false

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

module calendar './resources.bicep' = {
  name: 'trmnl-calendar-resources'
  scope: group
  params: {
    location: location
    functionAppName: functionAppName
    planName: planName
    storageAccountName: storageAccountName
    releaseStorageAccountName: releaseStorageAccountName
    hostIdentityName: hostIdentityName
    keyVaultName: keyVaultName
    logAnalyticsName: logAnalyticsName
    applicationInsightsName: applicationInsightsName
    budgetName: budgetName
    budgetAlertEmail: budgetAlertEmail
    agendaOwnerAddress: agendaOwnerAddress
    budgetStartDate: budgetStartDate
    sourceSecretName: sourceSecretName
    cacheContainerName: cacheContainerName
    deploymentContainerName: deploymentContainerName
    releaseControlContainerName: releaseControlContainerName
    releaseArtifactContainerName: releaseArtifactContainerName
    releaseControllerPrincipalId: releaseControllerPrincipalId
    retainHostDiagnostics: retainHostDiagnostics
  }
}

output agendaEndpoint string = calendar.outputs.agendaEndpoint
output cacheContainerResourceId string = calendar.outputs.cacheContainerResourceId
output deploymentContainerResourceId string = calendar.outputs.deploymentContainerResourceId
output releaseControlContainerResourceId string = calendar.outputs.releaseControlContainerResourceId
output releaseArtifactContainerResourceId string = calendar.outputs.releaseArtifactContainerResourceId
output functionPrincipalId string = calendar.outputs.functionPrincipalId
output sourceSecretName string = sourceSecretName
