// DukaanAI on Azure for Students: one Arm64 VM (the containers) and Azure
// Database for MySQL Flexible Server reached only over the VNet. Deploy into
// an empty resource group; a re-deploy with the same parameters converges.
//
//   az deployment group create -g <rg> -f deploy/azure/main.bicep \
//     -p deploy/azure/main.parameters.json \
//     -p mysqlAdminPassword=<secret> sshPublicKey="$(cat ~/.ssh/id_ed25519.pub)"
//
// What this costs out of the student credit, per month in Central India
// (Azure Retail Prices API, prices.azure.com, read 2026-10-16; the 12-month
// free amounts from azure.microsoft.com/en-us/pricing/purchase-options/azure-account):
//   VM Standard_B2pts_v2 (750 h free)           0.00, then 0.0056/h (~4.09)
//   MySQL Burstable B1ms, 32 GB, 32 GB backup   0.00, then 0.0245/h (~17.89) + storage
//   OS disk 64 GB Standard SSD E6 (not free)    5.28 + 0.002 per 10k operations
//     (Premium SSD P6: 10.21; the free list no longer has a "2 x 64 GB P6")
//   Standard static public IPv4 (not free)      0.005/h (~3.65)
//   Private DNS zone                            0.50 + 0.40 per million queries
//   Outbound data                               first 100 GB free, then 0.11/GB
//   VNet (azure.microsoft.com/en-us/pricing/details/virtual-network), NSG
//   (no meter), managed boot diagnostics (learn.microsoft.com/en-us/azure/
//   virtual-machines/boot-diagnostics: "not currently billed")  0.00
// About 9.50 a month while the free year lasts.

targetScope = 'resourceGroup'

@description('Prefix of every resource name: lower case letters, digits and hyphens.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'dukaanai'

@description('Region. Central India keeps the data in India; check the subscription\'s "Allowed resource deployment regions" policy first.')
param location string = resourceGroup().location

@description('Address (CIDR) allowed to reach SSH, e.g. your public IP as 203.0.113.7/32.')
param sshSourceCidr string

@description('OpenSSH public key of the VM\'s admin user.')
param sshPublicKey string

@description('Linux admin user of the VM.')
param vmAdminUser string = 'dukaan'

@description('Standard SSD (E6, cheaper) or Premium SSD (P6) for the 64 GB OS disk.')
@allowed([
  'StandardSSD_LRS'
  'Premium_LRS'
])
param osDiskType string = 'StandardSSD_LRS'

@description('MySQL admin login (not admin, root, azure_superuser or similar reserved names).')
param mysqlAdminUser string = 'dukaanadmin'

@description('MySQL admin password: 8-128 characters from three of upper case, lower case, digits and symbols; letters, digits and ._~- only, because bootstrap.sh puts it in a URL.')
@secure()
@minLength(8)
@maxLength(128)
param mysqlAdminPassword string

@description('Git ref cloud-init checks out on first boot; blank lets bootstrap.sh choose (the newest release that carries deploy/azure).')
param bootstrapRef string = ''

var tags = {
  app: 'dukaanai'
}
var suffix = take(uniqueString(resourceGroup().id), 6)
var mysqlServerName = toLower('${namePrefix}-mysql-${suffix}')
var vnetPrefix = '10.40.0.0/16'
var vmSubnetPrefix = '10.40.1.0/24'
var mysqlSubnetPrefix = '10.40.2.0/24'

// The server parameters, applied one at a time: Flexible Server refuses a
// configuration change while another one is still being applied.
// lower_case_table_names is a server property set once at creation (below).
var mysqlParameters = [
  {
    name: 'log_bin_trust_function_creators'
    value: 'ON'
  }
  {
    name: 'require_secure_transport'
    value: 'ON'
  }
  {
    name: 'character_set_server'
    value: 'utf8mb4'
  }
  {
    name: 'collation_server'
    value: 'utf8mb4_unicode_ci'
  }
  {
    name: 'time_zone'
    value: '+00:00'
  }
  {
    name: 'slow_query_log'
    value: 'ON'
  }
  {
    name: 'long_query_time'
    value: '1'
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2026-01-01' = {
  name: '${namePrefix}-vm-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-http'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
      {
        name: 'allow-https'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'allow-http3'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Udp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'allow-ssh-from-owner'
        properties: {
          priority: 130
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: sshSourceCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'deny-all-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2026-01-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetPrefix
      ]
    }
    subnets: [
      {
        name: 'vm'
        properties: {
          addressPrefix: vmSubnetPrefix
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
      {
        name: 'mysql'
        properties: {
          addressPrefix: mysqlSubnetPrefix
          delegations: [
            {
              name: 'mysql-flexible-server'
              properties: {
                serviceName: 'Microsoft.DBforMySQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }

  resource vmSubnet 'subnets' existing = {
    name: 'vm'
  }

  resource mysqlSubnet 'subnets' existing = {
    name: 'mysql'
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2026-01-01' = {
  name: '${namePrefix}-ip'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2026-01-01' = {
  name: '${namePrefix}-vm-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: vnet::vmSubnet.id
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2026-04-01' = {
  name: '${namePrefix}-vm'
  location: location
  tags: tags
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B2pts_v2'
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server-arm64'
        version: 'latest'
      }
      osDisk: {
        name: '${namePrefix}-vm-osdisk'
        createOption: 'FromImage'
        diskSizeGB: 64
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: osDiskType
        }
      }
    }
    osProfile: {
      computerName: '${namePrefix}-vm'
      adminUsername: vmAdminUser
      customData: base64(replace(loadTextContent('cloud-init.yaml'), '__DUKAANAI_REF__', bootstrapRef))
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${vmAdminUser}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
        provisionVMAgent: true
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource privateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${mysqlServerName}.private.mysql.database.azure.com'
  location: 'global'
  tags: tags

  resource vnetLink 'virtualNetworkLinks' = {
    name: '${namePrefix}-vnet-link'
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: vnet.id
      }
    }
  }
}

// 2025-06-01-preview is the version the Azure CLI itself uses to create
// Flexible Servers; the GA versions (2024-12-30) do not list MySQL 8.4.
resource mysql 'Microsoft.DBforMySQL/flexibleServers@2025-06-01-preview' = {
  name: mysqlServerName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '8.4'
    // Azure accepts only 1 or 2, never 0, and never changes it after
    // creation. With 1 every table is stored and dumped in lower case
    // (`shop`); lookups of `Shop` still resolve, so the API and the
    // migrations work, but a dump restores correctly only into a server that
    // also runs with 1.
    lowerCaseTableNames: 1
    administratorLogin: mysqlAdminUser
    administratorLoginPassword: mysqlAdminPassword
    createMode: 'Default'
    storage: {
      storageSizeGB: 32
      // Both stay off to stay inside the free 32 GB and the included IOPS:
      // auto-grow and auto IO scaling are billed per GB and per IO.
      autoGrow: 'Disabled'
      autoIoScaling: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: vnet::mysqlSubnet.id
      privateDnsZoneResourceId: privateDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [
    privateDns::vnetLink
  ]
}

@batchSize(1)
resource mysqlConfig 'Microsoft.DBforMySQL/flexibleServers/configurations@2024-12-30' = [
  for p in mysqlParameters: {
    parent: mysql
    name: p.name
    properties: {
      value: p.value
      source: 'user-override'
    }
  }
]

resource mysqlDatabase 'Microsoft.DBforMySQL/flexibleServers/databases@2024-12-30' = {
  parent: mysql
  name: 'dukaanai'
  properties: {
    charset: 'utf8mb4'
    collation: 'utf8mb4_unicode_ci'
  }
  dependsOn: [
    mysqlConfig
  ]
}

output vmPublicIp string = publicIp.properties.ipAddress
output mysqlFqdn string = mysql.properties.fullyQualifiedDomainName
output mysqlAdminUser string = mysqlAdminUser
output sshCommand string = 'ssh ${vmAdminUser}@${publicIp.properties.ipAddress}'
