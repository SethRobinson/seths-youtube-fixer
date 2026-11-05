# Export the approved artwork at platform-required sizes; no design is drawn here.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'store-assets\icon-master.png'))
$appRoot = 'platforms\safari\SethsYouTubeFixer\SethsYouTubeFixer'
$exports = @(
  @{ Size = 16; Path = 'src\icons\icon16.png' },
  @{ Size = 32; Path = 'src\icons\icon32.png' },
  @{ Size = 48; Path = 'src\icons\icon48.png' },
  @{ Size = 128; Path = 'src\icons\icon128.png' },
  @{ Size = 512; Path = 'store-assets\icon512.png' },
  @{ Size = 1024; Path = "$appRoot\Assets.xcassets\AppIcon.appiconset\universal-icon-1024@1x.png" },
  @{ Size = 128; Path = "$appRoot\Assets.xcassets\LargeIcon.imageset\icon128.png" },
  @{ Size = 128; Path = "$appRoot\Resources\Icon.png" }
)
try {
  if ($source.Width -ne $source.Height -or $source.Width -lt 1024) { throw 'Icon master must be square and at least 1024px.' }
  foreach ($export in $exports) {
    # iOS app icons must be opaque. Export RGB consistently on all platforms.
    $bitmap = [System.Drawing.Bitmap]::new($export.Size, $export.Size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
      $rect = [System.Drawing.Rectangle]::new(0, 0, $export.Size, $export.Size)
      $graphics.DrawImage($source, $rect, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
      $bitmap.Save((Join-Path $projectRoot $export.Path), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $attributes.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $source.Dispose() }
Write-Output 'Exported extension, store, and iOS icons.'
