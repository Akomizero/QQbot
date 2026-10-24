namespace Feiyu.Desktop;

internal enum ExitStep { AskTakeoverAndStop, StopOwned, BlockUnknownPort, Close }
internal static class ExitPolicy
{
    public static ExitStep Next(bool needsTakeover, bool managed, int ownedCount, bool portsReleased)
    {
        if (needsTakeover) return ExitStep.AskTakeoverAndStop;
        if (managed || ownedCount > 0) return ExitStep.StopOwned;
        if (!portsReleased) return ExitStep.BlockUnknownPort;
        return ExitStep.Close;
    }
}
