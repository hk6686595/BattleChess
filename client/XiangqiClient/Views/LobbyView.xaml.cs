using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using XiangqiClient.Models;
using XiangqiClient.ViewModels;

namespace XiangqiClient.Views;

public partial class LobbyView : UserControl
{
    public LobbyView()
    {
        InitializeComponent();
    }

    private MainViewModel? Vm => DataContext as MainViewModel;

    private void Logout_Click(object sender, RoutedEventArgs e) => Vm?.LogoutAsync();

    private void RoomList_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (RoomListView.SelectedItem is RoomListItem item)
        {
            Vm?.JoinRoom(item.Id, item.HasPassword);
        }
    }

    private void LobbyChat_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Vm != null && Vm.SendLobbyChatCmd.CanExecute(null))
        {
            Vm.SendLobbyChatCmd.Execute(null);
        }
    }
}
