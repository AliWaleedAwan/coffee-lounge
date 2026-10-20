; CoffeeLounge-Setup.exe (WINDOWS_DEPLOYMENT.md §1): one offline file that unpacks the
; bundle to a temporary folder and runs setup\install.ps1 in a console window, passing on
; its own command-line options (for example -CaExportDir E:\CoffeeLounge-Keys).
; Built by build-installer.ps1:  makensis /DVERSION=x.y.z /DBUNDLE=<dir> /DOUTFILE=<exe> installer.nsi

Unicode true
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef BUNDLE
  !error "Pass /DBUNDLE=<bundle folder>"
!endif
!ifndef OUTFILE
  !define OUTFILE "CoffeeLounge-Setup-${VERSION}.exe"
!endif

Name "Coffee Lounge ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel admin
; No wizard pages: the PowerShell console shows progress and asks for what it needs.
SilentInstall silent
SetCompressor /SOLID lzma
ManifestSupportedOS all

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Coffee Lounge"
VIAddVersionKey "CompanyName" "Coffee Lounge"
VIAddVersionKey "FileDescription" "Coffee Lounge installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Coffee Lounge"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\bundle"
  File /r "${BUNDLE}\*.*"
  ${GetParameters} $R0
  ClearErrors
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\bundle\setup\install.ps1" -Source "$PLUGINSDIR\bundle" $R0' $0
  IfErrors 0 +2
    StrCpy $0 1
  ; Leave the temporary folder so it can be deleted when the installer exits.
  SetOutPath "$TEMP"
  SetErrorLevel $0
SectionEnd
