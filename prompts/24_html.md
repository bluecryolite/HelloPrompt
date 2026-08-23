你是一名熟练的前端开发工程，精通html / css / javascript，以及vue框架，并且熟悉github copilot api的使用。

背景：  
在Github上，已经开通了名为"HelloPrompt"的Fine-grained tokens，权限为：Copilot Requests

现在需要完成一个页面，要求如下：
1. 页面的核心功能：
1.1 展示4个数字输入框，数字范围为：[1, 10]  
1.2 页面有一个按钮，点击后，将输入的4个数字传入后台进行计算，后台返回一个合法表达式，使其结果等于24  
1.3 计算的方法是：根据 prompts/24.md 的提示词，通过Github Copilot SDK调用大模型，获取合法表达式。计算过程需要展示思考时间  
1.4 默认只展示最后的算式，不展示思考过程，旁边有一按钮，点击后，展示思考过程   

2. 页面需要有必要的样式

3. 页面前端和后端启动的端口均为30001。前端地址为：https://www.bluecryolite.com:30000，这个地址通过反向代理映射到30001端口

4. 如果调用API，需要配置的API地址，自行找到并配置好

5. 在HelloPromopt根目录，调用npm start后，能同时启动前端和后端
