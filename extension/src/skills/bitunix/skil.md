It is withdraw automation for bitunix.com.
1. check if site is logined 

2. move to withdraw page
https://www.bitunix.com/assets/withdraw

3. select currency to ETH ( from request.currency )
4. select chain to base ( from request.chain )
5. add withdraw address ( from request.address )
6. add widthdraw amount ( from request.amount )
7. submit withdraw
8. confirm withdraw modal
9. verification request
it will show verification modal
send email verificaion code  - click "Get code" button
10. backend waits for Bitunix verification email via Gmail API
11. backend returns email code to extension
12. get code from google authenticator
13. add two codes to verification modal
14. submit verification