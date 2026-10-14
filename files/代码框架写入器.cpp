#include<bits/stdc++.h>
#include<windows.h>
using namespace std;

int main(){
    SetConsoleOutputCP(936);
    cout<<"请输入一共有几个题目,最多30个:";
    int n;
    cin>>n;
    string a[40];
    cout<<"\n请输入每题的名字：\n";
    for(int i=0;i<n;i++){
        cin>>a[i];
    }
    cout<<"需要把int转化为longlong吗？（Y/N）\n";
    char c,cc;
    bool ill=0,tie=0;
    cin>>c;
    cout<<"要加入加速输入输出吗？\n";
    cin>>cc;
    if(toupper(c)=='Y'){
    	ill=true;
	}
	if(toupper(cc)=='Y'){
    	tie=true;
	}
    cout<<"准备开始写入...";
    for(int i=0;i<n;i++){
        string fname=a[i]+".cpp",inname=a[i]+".in",outname=a[i]+".out";
        freopen(fname.c_str(),"w",stdout);
        if(!tie){
        	if(ill==0){
        		cout<<"#include<bits/stdc++.h>\nusing namespace std;\nint main(){\n    freopen(\""<<inname<<"\",\"r\",stdin);\n    freopen(\""<<outname<<"\",\"w\",stdout);\n\n    return 0;\n}";
			}
			else{
				cout<<"#include<bits/stdc++.h>\n#define int long long \nusing namespace std;\nsigned main(){\n    freopen(\""<<inname<<"\",\"r\",stdin);\n    freopen(\""<<outname<<"\",\"w\",stdout);\n\n    return 0;\n}";
			}
        
		}
        else{
        	if(ill==0){
        		cout<<"#include<bits/stdc++.h>\nusing namespace std;\nint main(){\n    ios::sync_with_stdio(0);\n    cin.tie(0);cout.tie(0);\n    freopen(\""<<inname<<"\",\"r\",stdin);\n    freopen(\""<<outname<<"\",\"w\",stdout);\n\n    return 0;\n}";
			}
			else{
				cout<<"#include<bits/stdc++.h>\n#define int long long \nusing namespace std;\nsigned main(){\n    ios::sync_with_stdio(0);\n    cin.tie(0);cout.tie(0);\n    freopen(\""<<inname<<"\",\"r\",stdin);\n    freopen(\""<<outname<<"\",\"w\",stdout);\n\n    return 0;\n}";
			}
		}
        fclose(stdout);
        freopen("CON","w",stdout);
        cout<<"\n正在写入文件"<<a[i]<<".cpp"<<"\nDone";
    }
    system("pause");
    return 0;
}