Create a .env file in the root directory and place your open-ai api key in that file as in the format:

```
OPENAI_API_KEY=your-actual-api-key
```

And you can run the test as follows

```shell
npm install
npm start
```
The following prompt clarifies my intention while doing this project, which is an actual prompt i used:


Ok, this is my previously written code. I want to modify it since even though the methods used to determine whether the page is a valid documentation page or not are good, the general structure of the methods is not sufficient for a functional understanding of a page's feature. 

I will change the approach, i want you to be correcting me, do not take what i exactly say but be creative a bit, consider your thoughts about this task without considering mine and combine to create a good project. 

I think we should do rule based static checks at the beginning like you did. the Regex part of yours is great, you can add more options to it but do not be too specific like adding a known single doc page. We also should check the subdomain url names. And please do not forget the fact that even though some url does not fit in the regExp rules, it may contain the words like docs, doc, learn, book, documentation etc.

There are two kinds of documentation i suppose, either it is a github, gitbucket etc page, or the page itself is dedicated for documentation. We can handle two different documentation types separately. Without forgetting the information we gained from regex and url checks we can move on with the pages like github bitbucket or gitlab etc.

These type of documentation can be indicated by the amount of .md file contained in it. In some of the documentation pages, there are even files having the same name with .md extension under different folders of  different languages, like tr, en, us, de, fr etc. Also we can copy the project structure with file names included to ask to an llm later on. It is highly possible to have a readme file in that, we can input what is inside the readme file to the llm along with the project structure that we have copied earlier with a proper prompt for it to check whether chatgpt thinks this is a documentation page or not. Combining all the static knowledge and the llm response, we can conclude whether the page is a valid documentation url or not. 

As i mentioned earlier, there is another type of documentation pages where the page is dedicated for the documentation. For this one, we should already do the url name checks as we did for the other one (also with the subdomains, the url part is important as for the other one). Nearly all the documentation pages i read have a sidebar. The existence of it is important, yet absence of it does not specifically mean that it is not a doc page. If there is a side bar we can copy the shallowest page structure names so that we can give to chatgpt later on. Of course it is important to go over the headers, whether the page includes code snippets, and checking for the nonDoc evidence is important. Afterwards, we can give the page content, if not too large, to llm along with the page sturcture depicted from the sidebar earlier with a proper separate prompt to make llm evaluate whether the page is a documentation page or not. And we can decide whether the page is a valid documentation page or not

These were the two general types. Do not overuse the evidence+=1 or docEvidence+=1 kind of metric since after some point it can lose its meaning, instead use a logical and more concrete approach as provided. you can be creative about what i gave you. But if you think there is something you can ask to me to be more clear, ask.
