using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using XiangqiClient.Models;
using XiangqiClient.ViewModels;

namespace XiangqiClient.Views;

public partial class RoomView : UserControl
{
    public RoomView()
    {
        InitializeComponent();
    }

    private MainViewModel? Vm => DataContext as MainViewModel;

    private void Board_CellClicked(Point2 cell)
    {
        if (Vm != null && Vm.CellClickCmd.CanExecute(cell))
        {
            Vm.CellClickCmd.Execute(cell);
        }
    }

    private void RoomChat_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Vm != null && Vm.SendRoomChatCmd.CanExecute(null))
        {
            Vm.SendRoomChatCmd.Execute(null);
        }
    }
}
