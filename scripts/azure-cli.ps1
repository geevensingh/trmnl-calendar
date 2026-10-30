function Assert-AgendaOwnerAddress {
    param([object]$Value)
    $ownerUri = $null
    $ownerMailbox = $null
    if ($Value -isnot [string] -or
        ![System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$ownerUri) -or
        $ownerUri.Scheme -cne 'mailto' -or $ownerUri.Query -or $ownerUri.Fragment -or
        $Value -match '\s|\p{Cc}') {
        throw 'agendaOwnerAddress must be one exact mailto: address.'
    }
    $ownerAddress = $ownerUri.GetComponents([System.UriComponents]::AbsoluteUri, [System.UriFormat]::Unescaped).
        Substring('mailto:'.Length)
    if (![System.Net.Mail.MailAddress]::TryCreate($ownerAddress, [ref]$ownerMailbox) -or
        $ownerMailbox.Address -cne $ownerAddress -or $ownerAddress.Contains(',') -or
        $ownerAddress -match '\s|\p{Cc}') {
        throw 'agendaOwnerAddress must be one exact mailto: address.'
    }
}

function Invoke-Azure {
    param([string[]]$Arguments, [string]$Stage, [switch]$Json)
    $PSNativeCommandUseErrorActionPreference = $false
    $diagnostics = [IO.Path]::GetTempFileName()
    try {
        $output = & az @Arguments --only-show-errors 2> $diagnostics
        if ($LASTEXITCODE -ne 0) {
            throw "$Stage failed (Azure CLI exit $LASTEXITCODE). Raw CLI diagnostics were withheld; inspect securely as the owner."
        }
        if ($Json) {
            try {
                return (($output -join "`n") | ConvertFrom-Json -AsHashtable)
            }
            catch [System.ArgumentException] {
                throw "$Stage returned unusable JSON. Raw output was withheld."
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $diagnostics -Force
    }
}
