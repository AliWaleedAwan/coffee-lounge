; CoffeeLounge-Setup.exe (WINDOWS_DEPLOYMENT.md §1; Phase 8 step 8.4): one offline file. Opened
; with no options it is a wizard: on a first install it asks for the shop address, the USB key
; folder, the key passphrase and the owner's password, then runs setup\install.ps1 with a progress
; log. With options (-Unattended, -RestoreFrom ...) it stays as it was: silent, running
; install.ps1 in a console and passing them on. Secrets reach install.ps1 only through this
; process's environment, never its command line, and go when the installer exits.
; Built by build-installer.ps1:  makensis /DVERSION=x.y.z /DBUNDLE=<dir> /DOUTFILE=<exe> installer.nsi

Unicode true
!include "FileFunc.nsh"
!include "x64.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

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
SetCompressor /SOLID lzma
ManifestSupportedOS all

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Coffee Lounge"
VIAddVersionKey "CompanyName" "Coffee Lounge"
VIAddVersionKey "FileDescription" "Coffee Lounge installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Coffee Lounge"

Var IsUpgrade
Var ShopIp
Var KeyDir
Var Passphrase
Var Owner
Var F1
Var F2
Var F3

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install Coffee Lounge"
!define MUI_WELCOMEPAGE_TEXT "This installs everything the shop needs on this PC: the database, the server and the counter app. Nothing else needs to be installed and no internet is needed.$\r$\n$\r$\nFor a first install, plug in the owner's USB key before you continue."
!define MUI_FINISHPAGE_TITLE "Coffee Lounge is ready"
!define MUI_FINISHPAGE_TEXT "It starts by itself with Windows from now on.$\r$\n$\r$\nOn a first install, the owner's recovery code and the shop keys are on the USB key. Print the code, keep it in the safe, and keep the USB key away from this PC."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Coffee Lounge"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp

!insertmacro MUI_PAGE_WELCOME
Page custom ShopPage ShopLeave
Page custom SecretsPage SecretsLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $R0
  StrCmp $R0 "" +2
    SetSilent silent
  ExpandEnvStrings $0 "%ProgramData%"
  StrCpy $IsUpgrade 0
  IfFileExists "$0\CoffeeLounge\pgdata\PG_VERSION" 0 +2
    StrCpy $IsUpgrade 1
  StrCpy $ShopIp "192.168.100.250"
FunctionEnd

Function ShopPage
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Shop details" "Where the system can be found, and where the keys go."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "This PC's fixed address on the shop network:"
  Pop $0
  ${NSD_CreateText} 0 13u 50% 13u "$ShopIp"
  Pop $F1
  ${NSD_CreateLabel} 0 36u 100% 12u "Folder on the owner's USB key:"
  Pop $0
  ${NSD_CreateDirRequest} 0 49u 75% 13u "$KeyDir"
  Pop $F2
  ${NSD_CreateBrowseButton} 77% 49u 23% 13u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseKey
  nsDialogs::Show
FunctionEnd

Function BrowseKey
  Pop $0
  nsDialogs::SelectFolderDialog "Choose a folder on the owner's USB key" ""
  Pop $0
  StrCmp $0 error +2
    ${NSD_SetText} $F2 "$0"
FunctionEnd

Function ShopLeave
  ${NSD_GetText} $F1 $ShopIp
  ${NSD_GetText} $F2 $KeyDir
  ${If} $ShopIp == ""
    MessageBox MB_ICONEXCLAMATION "Enter this PC's address."
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$KeyDir\*.*"
    MessageBox MB_ICONEXCLAMATION "Choose a folder that exists on the owner's USB key."
    Abort
  ${EndIf}
FunctionEnd

Function SecretsPage
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Passwords" "These are not stored in the installer, and cannot be read back."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Passphrase for the shop keys (at least 12 characters):"
  Pop $0
  ${NSD_CreatePassword} 0 13u 70% 13u ""
  Pop $F1
  ${NSD_CreateLabel} 0 32u 100% 12u "The same passphrase again:"
  Pop $0
  ${NSD_CreatePassword} 0 45u 70% 13u ""
  Pop $F2
  ${NSD_CreateLabel} 0 66u 100% 12u "Password for the owner, to log in with (at least 10 characters):"
  Pop $0
  ${NSD_CreatePassword} 0 79u 70% 13u ""
  Pop $F3
  nsDialogs::Show
FunctionEnd

Function SecretsLeave
  ${NSD_GetText} $F1 $Passphrase
  ${NSD_GetText} $F2 $0
  ${NSD_GetText} $F3 $Owner
  StrLen $1 $Passphrase
  ${If} $1 < 12
    MessageBox MB_ICONEXCLAMATION "The passphrase needs at least 12 characters."
    Abort
  ${EndIf}
  ${If} $0 != $Passphrase
    MessageBox MB_ICONEXCLAMATION "The two passphrases do not match."
    Abort
  ${EndIf}
  StrLen $1 $Owner
  ${If} $1 < 10
    MessageBox MB_ICONEXCLAMATION "The owner's password needs at least 10 characters."
    Abort
  ${EndIf}
FunctionEnd

Function OpenApp
  ; Through Explorer, so the app does not inherit the installer's administrator rights.
  Exec '"$WINDIR\explorer.exe" "$PROGRAMFILES64\CoffeeLounge\desktop\CoffeeLounge.exe"'
FunctionEnd

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\bundle"
  SetDetailsPrint none
  File /r "${BUNDLE}\*.*"
  SetDetailsPrint both
  ${GetParameters} $R0
  ; NSIS is a 32-bit program: without this, Windows would start the 32-bit PowerShell,
  ; which lacks LocalAccounts and writes HKLM\SOFTWARE under WOW6432Node.
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  StrCpy $R1 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\bundle\setup\install.ps1" -Source "$PLUGINSDIR\bundle"'
  ${If} ${Silent}
    ClearErrors
    ExecWait '$R1 $R0' $0
    IfErrors 0 +2
      StrCpy $0 1
  ${Else}
    ${If} $IsUpgrade == 1
      nsExec::ExecToLog '$R1 -Unattended -Wizard'
    ${Else}
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_PASSPHRASE", t "$Passphrase")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_OWNER_PASSWORD", t "$Owner")'
      nsExec::ExecToLog '$R1 -Unattended -Wizard -ShopIp "$ShopIp" -CaExportDir "$KeyDir"'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_PASSPHRASE", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_OWNER_PASSWORD", n)'
    ${EndIf}
    Pop $0
    ${If} $0 != 0
      SetOutPath "$TEMP"
      SetDetailsView show
      MessageBox MB_ICONSTOP "The installation did not finish. The steps are listed here, and in the log under C:\ProgramData\CoffeeLounge\logs."
      Abort "The installation did not finish."
    ${EndIf}
  ${EndIf}
  ; Leave the temporary folder so it can be deleted when the installer exits.
  SetOutPath "$TEMP"
  SetErrorLevel $0
SectionEnd
