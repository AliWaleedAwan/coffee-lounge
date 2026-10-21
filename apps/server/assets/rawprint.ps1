<#
  Sends raw ESC/POS bytes to a Windows print queue in RAW mode (PRINTING_HARDWARE.md §2,
  path F): the spooler passes them to the printer unchanged. The worker service runs it
  with Windows PowerShell 5.1 and pipes the job as base64 on standard input.

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File rawprint.ps1 -PrinterName "<queue>"

  Exit codes (the worker maps them to the print-job lifecycle):
    0   sent: the spooler accepted every byte
    10  the queue could not be opened (no such printer, no permission)   -> not sent
    11  the document could not be started                                -> not sent
    20  writing failed or was short, after the document started          -> uncertain
    30  no input                                                         -> not sent
    1   anything else                                                    -> uncertain
#>
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [string]$DocName = 'Coffee Lounge'
)
$ErrorActionPreference = 'Stop'

try {
  $data = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())
} catch {
  [Console]::Error.WriteLine("Input is not base64: $($_.Exception.Message)")
  exit 30
}
if ($data.Length -eq 0) { [Console]::Error.WriteLine('Nothing to print'); exit 30 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ClRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string DocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string OutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DocInfo info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

  // Returns an exit code (see the script header) and fills message on failure.
  public static int Send(string printer, string docName, byte[] data, out string message) {
    message = "";
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) {
      message = "Cannot open printer '" + printer + "' (Windows error " + Marshal.GetLastWin32Error() + ")";
      return 10;
    }
    try {
      DocInfo info = new DocInfo();
      info.DocName = docName;
      info.DataType = "RAW";
      if (StartDocPrinter(h, 1, info) == 0) {
        message = "Cannot start the print job (Windows error " + Marshal.GetLastWin32Error() + ")";
        return 11;
      }
      try {
        StartPagePrinter(h);
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) {
          message = "Wrote " + written + " of " + data.Length + " bytes (Windows error " + Marshal.GetLastWin32Error() + ")";
          return 20;
        }
        return 0;
      } finally {
        EndDocPrinter(h);
      }
    } finally {
      ClosePrinter(h);
    }
  }
}
'@

try {
  $message = ''
  $code = [ClRawPrinter]::Send($PrinterName, $DocName, $data, [ref]$message)
  if ($code -ne 0) { [Console]::Error.WriteLine($message) }
  exit $code
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
