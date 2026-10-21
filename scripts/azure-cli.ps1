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
