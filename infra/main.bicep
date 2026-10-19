targetScope = 'subscription'

@allowed(['westus2'])
param location string
param resourceGroupName string
param functionAppName string
param planName string
param storageAccountName string
param hostIdentityName string
param keyVaultName string
param logAnalyticsName string
param applicationInsightsName string
param budgetName string

@secure()
@minLength(3)
param budgetAlertEmail string

@description('Original budget creation month start in UTC; preserve it on repeat deployments.')
param budgetStartDate string
param sourceSecretName string = 'calendar-source-url'
param cacheContainerName string = 'source-cache'
param deploymentContainerName string = 'app-packages'

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
    hostIdentityName: hostIdentityName
    keyVaultName: keyVaultName
    logAnalyticsName: logAnalyticsName
    applicationInsightsName: applicationInsightsName
    budgetName: budgetName
    budgetAlertEmail: budgetAlertEmail
    budgetStartDate: budgetStartDate
    sourceSecretName: sourceSecretName
    cacheContainerName: cacheContainerName
    deploymentContainerName: deploymentContainerName
    retainHostDiagnostics: retainHostDiagnostics
  }
}

output agendaEndpoint string = calendar.outputs.agendaEndpoint
output cacheContainerResourceId string = calendar.outputs.cacheContainerResourceId
output deploymentContainerResourceId string = calendar.outputs.deploymentContainerResourceId
output functionPrincipalId string = calendar.outputs.functionPrincipalId
output sourceSecretName string = sourceSecretName
