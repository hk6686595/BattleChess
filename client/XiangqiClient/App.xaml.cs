using System.Windows;
using System.Windows.Threading;

namespace XiangqiClient;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // 兜底：任何未处理的 UI 线程异常（含 async void 回调）都给出提示，
        // 而不是让程序直接崩溃退出
        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show(
                "程序遇到未处理的错误：\n" + args.Exception.Message,
                "对战平台",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            args.Handled = true;
        };
        base.OnStartup(e);
    }
}
